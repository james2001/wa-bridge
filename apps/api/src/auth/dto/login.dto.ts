import { IsNotEmpty, IsString } from 'class-validator';
import type { LoginRequest } from '@app/shared-types';

export class LoginDto implements LoginRequest {
  @IsString()
  @IsNotEmpty()
  password!: string;
}
