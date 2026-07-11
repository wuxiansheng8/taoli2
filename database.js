const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const KEY_FILE = path.join(DATA_DIR, '.key');
const COOLDOWNS_FILE = path.join(DATA_DIR, 'cooldowns.json');

const ENCRYPTION_ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// Create data directory if it doesn't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Generate or read the dynamic machine-unique secret key
function getEncryptionKey() {
  if (!fs.existsSync(KEY_FILE)) {
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(KEY_FILE, key, 'utf8');
    try {
      fs.chmodSync(KEY_FILE, 0o600); // Strict permission on Linux
    } catch (e) {
      // Ignore on Windows
    }
  }
  const rawKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  return crypto.createHash('sha256').update(rawKey).digest();
}

// Password hashing helper (PBKDF2 with SHA-256)
function hashPassword(password, salt) {
  const finalSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, finalSalt, 1000, 64, 'sha256').toString('hex');
  return { hash, salt: finalSalt };
}

// Default settings (Pre-hashed admin123 password)
const defaultHashObj = hashPassword('admin123');
const DEFAULT_SETTINGS = {
  defaultHotkey: "",
  webPort: 8080,
  webUser: 'admin',
  webPassHash: defaultHashObj.hash,
  webPassSalt: defaultHashObj.salt,
  primaryNode: 'ws://127.0.0.1:9944',
  backupNode: 'wss://entrypoint-finney.opentensor.ai:443',
  mempoolPollIntervalMs: 1,
  nonceSyncIntervalSeconds: 60,
  
  telegramEnabled: false,

  telegramToken: '',
  telegramChatId: '',
  
  // FlashDuty settings
  flashDutyEnabled: false,
  flashDutyWebhookUrl: '',
  flashDutyCooldownMs: 300000, // 默认 5 分钟
  
  // Strategy: New Subnet Auto Register
  dashingEnabled: true,
  dashingAmount: 100, // TAO to register
  dashingRetries: 10,
  dashingIntervalMs: 1000,
  dashingTimeoutMs: 30000,
  dashingBurstCount: 1, // number of concurrent staking transactions per wallet
  dashingDoubleStakingDelay: 0, // delay in seconds for second buy-in
  dashingTimeoutRetries: 0,
  dashingMaxPrice: 0, // 主线固定最高限价 (TAO/Alpha, 策略 1 开启时必须 > 0)
  dashingDoubleMaxPrice: 0, // 二次延迟固定最高限价 (TAO/Alpha, 二次延迟开启时必须 > 0)
  
  // Strategy: Subnet Rename Frontrun
  renameEnabled: true,
  renameAmount: 100,
  renameSlippageLimit: 0.05, // 5% slippage
  renameRetries: 1,
  renameIntervalMs: 1000,
  renameTimeoutMs: 30000,
  renameBurstCount: 1,
  renameTimeoutRetries: 0,
  
  // Strategy: Coldkey Swap Frontrun
  swapEnabled: true,
  swapAmount: 100,
  swapSlippageLimit: 0.05, // 5% slippage
  swapRetries: 1,
  swapIntervalMs: 1000,
  swapTimeoutMs: 30000,
  swapBurstCount: 1,
  swapTimeoutRetries: 0,

  // Strategy: TAO-side Emission Enable Frontrun
  emissionEnabled: false,
  emissionAmount: 100,
  emissionSlippageLimit: 0.05,
  emissionRetries: 1,
  emissionIntervalMs: 1000,
  emissionTimeoutMs: 30000,
  emissionBurstCount: 1,
  
  // Advanced priorities
  allowPartialStaking: true, // allow partial fill on limit orders
  broadcastNodes: [
    "wss://entrypoint-finney.opentensor.ai:443",
    "wss://archival.finney.opentensor.ai:443"
  ]
};

// Encryption helpers using dynamic key
function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  try {
    const key = getEncryptionKey();
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return 'DECRYPTION_ERROR';
  }
}

let settingsCache = null;
let cooldownsCache = null;
let cooldownsFlushTimer = null;

function cleanSettings(settings) {
  const next = { ...settings };
  // 主动剔除历史配置文件里的旧 MEV 属性，让其自动退场
  delete next.dashingMevShieldEnabled;
  delete next.renameMevShieldEnabled;
  delete next.swapMevShieldEnabled;
  delete next.sandwichEnabled;
  delete next.sandwichAmount;
  delete next.sandwichThreshold;
  delete next.sandwichTip;
  delete next.sandwichAutoSell;
  delete next.sandwichSellTip;
  delete next.sandwichSlippageLimit;
  delete next.sandwichTimeoutMs;
  delete next.dynamicSlippageEnabled;
  delete next.dynamicSlippageSafetyFactor;
  delete next.dashingTip;
  delete next.renameTip;
  delete next.swapTip;
  delete next.rateLimitPerSec;
  // 策略 1 已改为固定最高限价，清理旧滑点配置。
  delete next.dashingSlippageLimit;
  delete next.dashingDoubleSlippageLimit;
  return next;
}

function initCache() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      settingsCache = { ...DEFAULT_SETTINGS };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2), 'utf8');
    } else {
      const rawData = fs.readFileSync(SETTINGS_FILE, 'utf8');
      settingsCache = { ...DEFAULT_SETTINGS, ...cleanSettings(JSON.parse(rawData)) };
    }
  } catch (e) {
    console.error('Error reading settings file, using defaults:', e);
    settingsCache = { ...DEFAULT_SETTINGS };
  }

  try {
    if (fs.existsSync(COOLDOWNS_FILE)) {
      cooldownsCache = JSON.parse(fs.readFileSync(COOLDOWNS_FILE, 'utf8'));
    } else {
      cooldownsCache = {};
    }
  } catch (e) {
    console.error('Error reading cooldowns:', e);
    cooldownsCache = {};
  }
}

function flushCooldownsSoon() {
  if (cooldownsFlushTimer) return;
  cooldownsFlushTimer = setTimeout(() => {
    cooldownsFlushTimer = null;
    const snapshot = cooldownsCache || {};
    fs.promises.writeFile(COOLDOWNS_FILE, JSON.stringify(snapshot, null, 2), 'utf8')
      .catch(e => console.error('Error async writing cooldowns:', e));
  }, 1000);
  if (typeof cooldownsFlushTimer.unref === 'function') {
    cooldownsFlushTimer.unref();
  }
}

initCache();

// Settings management
function getSettings() {
  if (!settingsCache) initCache();
  return { ...settingsCache };
}

function saveSettings(settings) {
  try {
    settingsCache = { ...DEFAULT_SETTINGS, ...cleanSettings(settings) };
    fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2), 'utf8')
      .catch(e => console.error('Error async writing settings:', e));

    // 主动清空 config.js 的一秒缓存，使 Web 端修改即刻生效
    try {
      require('./src/config').invalidate();
    } catch (err) {}

    return true;
  } catch (e) {
    console.error('Error writing settings file:', e);
    return false;
  }
}

// Wallets management
function getWallets(shouldDecrypt = false) {
  if (!fs.existsSync(WALLETS_FILE)) {
    saveWallets([]);
    return [];
  }
  try {
    const rawData = fs.readFileSync(WALLETS_FILE, 'utf8');
    const wallets = JSON.parse(rawData);
    
    return wallets.map(wallet => {
      const w = { ...wallet };
      if (shouldDecrypt && w.secretEncrypted) {
        w.secret = decrypt(w.secretEncrypted);
      }
      // Never send encrypted key directly to UI with secret
      if (!shouldDecrypt) {
        delete w.secretEncrypted;
      }
      return w;
    });
  } catch (e) {
    console.error('Error reading wallets file:', e);
    return [];
  }
}

function saveWallets(wallets) {
  try {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error writing wallets file:', e);
    return false;
  }
}

function addWallet(name, keyType, secret, address) {
  const wallets = getWallets(true);
  
  if (wallets.some(w => w.name === name)) {
    return { success: false, message: 'Wallet name already exists' };
  }
  
  const encrypted = encrypt(secret.trim());
  const newWallet = {
    name: name.trim(),
    keyType: keyType,
    address: address.trim(),
    secretEncrypted: encrypted,
    createdAt: new Date().toISOString()
  };
  
  wallets.push(newWallet);
  
  const toSave = wallets.map(w => ({
    name: w.name,
    keyType: w.keyType,
    address: w.address,
    secretEncrypted: w.secretEncrypted || encrypt(w.secret),
    createdAt: w.createdAt
  }));
  
  saveWallets(toSave);
  return { success: true };
}

function deleteWallet(name) {
  const wallets = getWallets(true);
  const filtered = wallets.filter(w => w.name !== name);
  
  if (wallets.length === filtered.length) {
    return { success: false, message: 'Wallet not found' };
  }
  
  const toSave = filtered.map(w => ({
    name: w.name,
    keyType: w.keyType,
    address: w.address,
    secretEncrypted: w.secretEncrypted || encrypt(w.secret),
    createdAt: w.createdAt
  }));
  
  saveWallets(toSave);
  return { success: true };
}

function getCooldown(key) {
  if (!cooldownsCache) initCache();
  return cooldownsCache[key] || null;
}

function setCooldown(key, data) {
  try {
    if (!cooldownsCache) initCache();
    cooldownsCache[key] = {
      ...data,
      firstTriggeredAt: Date.now()
    };
    
    // Clean up expired cooldowns (older than 24 hours)
    const now = Date.now();
    const expiry = 24 * 60 * 60 * 1000;
    for (const k in cooldownsCache) {
      if (!cooldownsCache[k] || !cooldownsCache[k].firstTriggeredAt || now - cooldownsCache[k].firstTriggeredAt > expiry) {
        delete cooldownsCache[k];
      }
    }

    flushCooldownsSoon();
    return true;
  } catch (e) {
    console.error('Error writing cooldowns:', e);
    return false;
  }
}

function clearCooldownsByStrategy(strategyPrefix) {
  try {
    if (!cooldownsCache) initCache();
    let clearedCount = 0;
    
    for (const key in cooldownsCache) {
      if (
        (strategyPrefix === 'new-subnet' && (
          key.startsWith('new-subnet:') ||
          key.startsWith('new-subnet-primary:') ||
          key.startsWith('new-subnet-double:')
        )) ||
        (strategyPrefix === 'rename' && key.startsWith('rename:')) ||
        (strategyPrefix === 'coldkey-swap' && key.startsWith('coldkey-swap:'))
      ) {
        delete cooldownsCache[key];
        clearedCount++;
      }
    }

    flushCooldownsSoon();
    return clearedCount;
  } catch (e) {
    console.error('Error clearing cooldowns:', e);
    return 0;
  }
}

module.exports = {
  getSettings,
  saveSettings,
  getWallets,
  addWallet,
  deleteWallet,
  hashPassword,
  getCooldown,
  setCooldown,
  clearCooldownsByStrategy,
  decrypt
};
