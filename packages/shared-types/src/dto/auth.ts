// Authentification d'ACCÈS À L'APP (distincte du lien WhatsApp via QR).
// Un mot de passe d'app (défini dans .env) protège l'accès au pont.

export interface LoginRequest {
  password: string;
}

// Le refresh token est posé en cookie HttpOnly ; le body ne contient que l'access.
export interface AuthSession {
  accessToken: string;
}

export interface RefreshResponse {
  accessToken: string;
}
