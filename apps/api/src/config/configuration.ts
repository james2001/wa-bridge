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
}

export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
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
});
