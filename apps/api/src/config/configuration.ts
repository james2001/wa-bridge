/**
 * Configuration typée chargée depuis process.env (validée au boot par env.validation.ts).
 */
export interface AppConfig {
  nodeEnv: string;
  apiPort: number;
  databaseUrl: string;
  corsOrigins: string[];
  appPassword: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  // Répertoire où Baileys persiste l'état de session WhatsApp (volume).
  waAuthDir: string;
  // Répertoire de cache disque des médias déchiffrés (volume).
  waMediaDir: string;
  // --- API Agent/LLM (server-to-server) ---
  // Clé statique attendue dans X-API-Key. null/vide => API agent désactivée
  // (fail-closed). Feature opt-in.
  agentApiKey: string | null;
  // Autorise l'écriture (envoi de texte) via l'API agent. Défaut: false.
  agentWriteEnabled: boolean;
  // Autorise l'envoi de média via l'API agent. Défaut: false.
  agentAllowMedia: boolean;
  // Allow-list de comptes autorisés (vide => aucune restriction).
  agentAccountAllowlist: string[];
  // Allow-list de discussions (JID) autorisées (vide => aucune restriction).
  agentChatAllowlist: string[];
}

export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

// Parse une liste CSV en tableau nettoyé (réutilisée par les allow-lists agent).
export function parseCsvList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// Interprète une variable d'environnement booléenne ('true'/'1' => true).
function parseBool(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  apiPort: parseInt(process.env.API_PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL as string,
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  appPassword: process.env.APP_PASSWORD as string,
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET as string,
    refreshSecret: process.env.JWT_REFRESH_SECRET as string,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  },
  waAuthDir: process.env.WA_AUTH_DIR ?? '/data/wa-auth',
  waMediaDir: process.env.WA_MEDIA_DIR ?? '/data/media-cache',
  agentApiKey: process.env.AGENT_API_KEY?.trim() || null,
  agentWriteEnabled: parseBool(process.env.AGENT_WRITE_ENABLED),
  agentAllowMedia: parseBool(process.env.AGENT_ALLOW_MEDIA),
  agentAccountAllowlist: parseCsvList(process.env.AGENT_ACCOUNT_ALLOWLIST),
  agentChatAllowlist: parseCsvList(process.env.AGENT_CHAT_ALLOWLIST),
});
