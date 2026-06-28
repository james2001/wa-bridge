import { QRCodeSVG } from 'qrcode.react';
import { ConnectionState } from '@app/shared-types';
import type { WaConnection } from '@app/shared-types';
import { useAppSelector } from '../../app/hooks';
import { selectConnection } from './waSlice';

function ConnectingBody() {
  return (
    <>
      <div className="spinner" />
      <p className="connscreen__hint">Connexion à WhatsApp…</p>
    </>
  );
}

function QrBody({ qr }: { qr: string }) {
  return (
    <>
      <h2 className="connscreen__title">Lie ton WhatsApp</h2>
      <div className="connscreen__qr">
        {/* La clé force le re-rendu de l'image quand le QR change. */}
        <QRCodeSVG key={qr} value={qr} size={240} level="M" marginSize={4} />
      </div>
      <ol className="connscreen__steps">
        <li>1. Ouvre WhatsApp sur ton téléphone</li>
        <li>2. Va dans Appareils connectés &gt; Lier un appareil</li>
        <li>3. Scanne ce code</li>
      </ol>
    </>
  );
}

function body(connection: WaConnection) {
  switch (connection.state) {
    case ConnectionState.QR:
      return connection.qr ? (
        <QrBody qr={connection.qr} />
      ) : (
        <ConnectingBody />
      );
    case ConnectionState.LOGGED_OUT:
      return (
        <>
          <div className="spinner" />
          <p className="connscreen__hint">
            Session déconnectée, un nouveau QR va apparaître…
          </p>
        </>
      );
    case ConnectionState.CLOSE:
      return (
        <>
          <div className="spinner" />
          <p className="connscreen__hint">Reconnexion…</p>
        </>
      );
    case ConnectionState.CONNECTING:
    default:
      return <ConnectingBody />;
  }
}

export default function ConnectionScreen() {
  const connection = useAppSelector(selectConnection);

  return (
    <div className="connscreen">
      <div className="connscreen__card">
        <div className="connscreen__brand">
          <div className="login__logo">W</div>
        </div>
        {body(connection)}
      </div>
    </div>
  );
}
