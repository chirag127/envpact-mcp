import path from 'node:path';
import os from 'node:os';

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();

export const CONFIG_DIR = path.join(HOME, '.envpact');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const SECRETS_DIR = path.join(CONFIG_DIR, 'secrets');
export const SECRETS_FILE = path.join(SECRETS_DIR, 'secrets.json');
export const AGE_KEY_FILE = path.join(CONFIG_DIR, 'age.key');

export const VAULT_SCHEMA_VERSION = 3;
export const SCHEMA_URL = 'https://envpact.oriz.in/schema/v3.json';
