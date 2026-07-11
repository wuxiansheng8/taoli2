const database = require('../database');

let cachedSettings = null;
let lastFetchTime = 0;

function getSettings(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh || !cachedSettings || now - lastFetchTime > 1000) {
    cachedSettings = database.getSettings();
    lastFetchTime = now;
  }
  return cachedSettings;
}

function getDerivedConfig() {
  const settings = getSettings();
  const doubleStakingDelay = Number(settings.dashingDoubleStakingDelay || 0);
  const dashingActive = settings.dashingEnabled || doubleStakingDelay > 0;
  return {
    dashingActive,
    doubleStakingDelay
  };
}

function invalidate() {
  cachedSettings = null;
  lastFetchTime = 0;
}

module.exports = {
  getSettings,
  getDerivedConfig,
  invalidate
};
