import { useEffect, useState } from 'react';
import { ConnectionState } from '@app/shared-types';
import { useAppSelector } from './hooks';
import { selectIsAuthenticated } from '../features/auth/authSlice';
import { useRefreshMutation } from '../features/auth/authApi';
import { useGetStatusQuery } from '../features/whatsapp/waApi';
import { selectConnection } from '../features/whatsapp/waSlice';
import { useSocketBridge } from '../hooks/useSocketBridge';
import LoginPage from '../features/auth/LoginPage';
import ConnectionScreen from '../features/whatsapp/ConnectionScreen';
import AppLayout from './AppLayout';

function Splash() {
  return (
    <div className="splash">
      <div className="splash__logo">W</div>
    </div>
  );
}

// Rendu uniquement quand l'app est authentifiée: charge l'état WhatsApp et
// affiche le QR ou l'interface selon l'état de la connexion.
function AuthedApp() {
  useGetStatusQuery();
  const connection = useAppSelector(selectConnection);

  if (connection.state !== ConnectionState.OPEN) {
    return <ConnectionScreen />;
  }
  return <AppLayout />;
}

export default function App() {
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const [refresh] = useRefreshMutation();
  const [booting, setBooting] = useState(true);

  // Pont socket monté en permanence: se (dé)connecte selon le token courant
  // (déconnecté pendant le login, connecté dès l'auth — y compris pour le QR).
  useSocketBridge();

  // Au démarrage: tente de restaurer la session via le cookie refresh.
  useEffect(() => {
    let active = true;
    refresh()
      .unwrap()
      .catch(() => {
        /* pas de session valide -> écran de login */
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  if (booting) return <Splash />;
  if (!isAuthenticated) return <LoginPage />;
  return <AuthedApp />;
}
