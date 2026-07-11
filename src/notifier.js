const axios = require('axios');
const database = require('../database');
const privateWallet = require('./privateWallet');
const { log } = require('./logger');

let lastFlashDutyAlertTime = 0;

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeErrorMessage(msg) {
  if (!msg) return '';
  return msg.replace(/integration_key=[a-zA-Z0-9_-]+/gi, 'integration_key=******');
}

async function sendTelegramAlert(text) {
  if (privateWallet.shouldSuppress(text)) {
    return;
  }
  const settings = database.getSettings();
  if (!settings.telegramEnabled || !settings.telegramToken || !settings.telegramChatId) {
    return;
  }
  const url = `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: settings.telegramChatId,
      text: `🤖 【套利机器人告警】\n\n${text}\n\n[北京时间]: ${new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').replace('Z', '')}`,
      parse_mode: 'HTML'
    }, { timeout: 5000 });
  } catch (err) {
    console.error('Failed to send Telegram alert:', err.message);
  }
}

async function testTelegram(token, chatId) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const start = Date.now();
  try {
    const res = await axios.post(url, {
      chat_id: chatId,
      text: `🎉 套利机器人 Telegram 推送测试成功！\n测试延迟: ${Date.now() - start}ms`
    }, { timeout: 5000 });
    return { success: res.data.ok, message: 'Message sent successfully' };
  } catch (err) {
    return { success: false, error: err.response?.data?.description || err.message };
  }
}

async function sendFlashDutyAlert(title, description, settings) {
  if (privateWallet.shouldSuppress(title) || privateWallet.shouldSuppress(description)) {
    return;
  }
  const actualSettings = settings || database.getSettings();
  if (!actualSettings || !actualSettings.flashDutyEnabled || !actualSettings.flashDutyWebhookUrl) {
    return;
  }

  const now = Date.now();
  const cooldownMs = actualSettings.flashDutyCooldownMs !== undefined ? Number(actualSettings.flashDutyCooldownMs) : 300000;

  if (now - lastFlashDutyAlertTime < cooldownMs) {
    const cooldownMins = Math.ceil(cooldownMs / 60000);
    log('INFO', `[FlashDuty] 处于 ${cooldownMins} 分钟冷却中，已跳过本次电话告警: ${title}`);
    return;
  }

  lastFlashDutyAlertTime = now;

  const payload = {
    title_rule: title,
    event_status: 'Critical',
    description: description,
    labels: {
      service: 'taoli',
      event: 'flashduty_alert'
    }
  };

  try {
    await axios.post(actualSettings.flashDutyWebhookUrl, payload, { timeout: 10000 });
    log('SUCCESS', `[FlashDuty] 电话告警事件发送成功: ${title}`);
  } catch (err) {
    const rawError = err.message || String(err);
    const safeError = sanitizeErrorMessage(rawError);
    log('WARN', `[FlashDuty] 电话告警发送失败: ${safeError}`);
    lastFlashDutyAlertTime = 0;
  }
}

async function testFlashDuty(webhookUrl) {
  const payload = {
    title_rule: "TAOLI 测试电话告警",
    event_status: "Critical",
    description: "这是 TAOLI 的 FlashDuty 测试电话告警",
    labels: {
      service: "taoli",
      event: "flashduty_test"
    }
  };

  try {
    await axios.post(webhookUrl, payload, { timeout: 10000 });
    return { success: true };
  } catch (err) {
    const rawError = err.response?.data?.message || err.message;
    const safeError = sanitizeErrorMessage(rawError);
    return { success: false, error: safeError };
  }
}

module.exports = {
  sendTelegramAlert,
  testTelegram,
  sendFlashDutyAlert,
  testFlashDuty,
  escapeHtml
};
