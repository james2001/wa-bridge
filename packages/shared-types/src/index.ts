// Contrat partagé front/back du pont WhatsApp Web auto-hébergé.
export * from './enums';
export * from './dto/auth';
export * from './dto/whatsapp';
export * from './socket/client-to-server';
export * from './socket/server-to-client';

// Données attachées à chaque socket authentifié côté serveur.
export interface SocketData {
  appUserId: string;
}
