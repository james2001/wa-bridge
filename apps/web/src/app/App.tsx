import { useEffect, useState } from 'react';
import { ConnectionState } from '@app/shared-types';
import { useAppSelector } from './hooks';
import { selectIsAuthenticated } from '../features/auth/authSlice';
import { useRefreshMutation } from '../features/auth/authApi';
import {
  useGetAccountsQuery,
  useGetStatusQuery,
} from '../features/whatsapp/waApi';
import { selectConnections } from '../features/whatsapp/waSlice';
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

// Rendu uniquement quand l'app est authentifiée: charge l'état WhatsApp puis
// affiche l'interface dès qu'AU MOINS UN compte est lié (OPEN). L'onboarding
// (ConnectionScreen -> QR du compte principal) ne s'affiche que si AUCUN compte
// n'est utilisable, pour ne pas rendre un compte secondaire lié inaccessible
// quand le compte principal décroche temporairement.
function AuthedApp() {
  useGetStatusQuery();
  useGetAccountsQuery();
  const connections = useAppSelector(selectConnections);
  const anyOpen = Object.values(connections).some(
    (c) => c.state === ConnectionState.OPEN,
  );

  if (!anyOpen) {
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
