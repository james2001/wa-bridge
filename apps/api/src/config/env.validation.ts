import { plainToInstance } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateIf,
  validateSync,
} from 'class-validator';

/**
 * Validation des variables d'environnement. Le boot échoue si une variable
 * requise manque ou est invalide.
 */
class EnvironmentVariables {
  @IsOptional()
  @IsString()
  NODE_ENV?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  API_PORT?: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  CORS_ORIGINS!: string;

  // Mot de passe d'accès à l'app (gate du pont WhatsApp).
  @IsString()
  @MinLength(6)
  APP_PASSWORD!: string;

  @IsString()
  @MinLength(16)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(16)
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_TTL!: string;

  @IsOptional()
  @IsString()
  WA_AUTH_DIR?: string;

  @IsOptional()
  @IsString()
  WA_MEDIA_DIR?: string;

  // --- API Agent/LLM (server-to-server) ---
  // Clé statique (X-API-Key). Optionnelle (absente/vide => API agent
  // désactivée) ; si fournie non vide, elle doit faire au moins 32 caractères.
  // ValidateIf ignore l'état "vide" documenté (disabled) pour ne pas bloquer le boot.
  @ValidateIf((o: EnvironmentVariables) => !!o.AGENT_API_KEY)
  @IsOptional()
  @IsString()
  @MinLength(32)
  AGENT_API_KEY?: string;

  @IsOptional()
  @IsString()
  AGENT_WRITE_ENABLED?: string;

  @IsOptional()
  @IsString()
  AGENT_ALLOW_MEDIA?: string;

  @IsOptional()
  @IsString()
  AGENT_ACCOUNT_ALLOWLIST?: string;

  @IsOptional()
  @IsString()
  AGENT_CHAT_ALLOWLIST?: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => Object.values(e.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Configuration d'environnement invalide: ${details}`);
  }
  return validated;
}
