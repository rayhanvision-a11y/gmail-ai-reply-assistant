/**
 * Settings & Configuration Management for AI Reply Assistant
 */

var SETTINGS_KEYS = {
  GEMINI_API_KEY: 'GEMINI_API_KEY',
  DEFAULT_TONE: 'DEFAULT_TONE',
  DEFAULT_LANGUAGE: 'DEFAULT_LANGUAGE',
  USER_SIGN_OFF: 'USER_SIGN_OFF'
};

/**
 * Get Gemini API key stored in UserProperties
 * @return {string}
 */
function getApiKey() {
  var props = PropertiesService.getUserProperties();
  return props.getProperty(SETTINGS_KEYS.GEMINI_API_KEY) || '';
}

/**
 * Save Gemini API key
 * @param {string} key
 */
function saveApiKey(key) {
  var props = PropertiesService.getUserProperties();
  if (key && key.trim()) {
    props.setProperty(SETTINGS_KEYS.GEMINI_API_KEY, key.trim());
  } else {
    props.deleteProperty(SETTINGS_KEYS.GEMINI_API_KEY);
  }
}

/**
 * Get preferred tone
 * @return {string}
 */
function getDefaultTone() {
  var props = PropertiesService.getUserProperties();
  return props.getProperty(SETTINGS_KEYS.DEFAULT_TONE) || 'professional';
}

/**
 * Set preferred tone
 * @param {string} tone
 */
function setDefaultTone(tone) {
  var props = PropertiesService.getUserProperties();
  props.setProperty(SETTINGS_KEYS.DEFAULT_TONE, tone);
}

/**
 * Get user custom sign-off (e.g. "Best regards, John")
 * @return {string}
 */
function getUserSignOff() {
  var props = PropertiesService.getUserProperties();
  return props.getProperty(SETTINGS_KEYS.USER_SIGN_OFF) || '';
}

/**
 * Set user custom sign-off
 * @param {string} signOff
 */
function setUserSignOff(signOff) {
  var props = PropertiesService.getUserProperties();
  props.setProperty(SETTINGS_KEYS.USER_SIGN_OFF, signOff ? signOff.trim() : '');
}
