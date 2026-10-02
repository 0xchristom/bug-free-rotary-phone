import type { VaultInfo } from '../../worker/protocol.ts';

export interface FleetScreenProps {
  readonly info: VaultInfo;
}

export function FleetScreen({ info }: FleetScreenProps) {
  return (
    <section className="screen" aria-labelledby="fleet-title">
      <h2 id="fleet-title">Flota</h2>
      <p>
        Portfele we flocie: <strong>{info.wallets.length}</strong>
      </p>
      <p className="muted">Tabela portfeli pojawi się tutaj.</p>
    </section>
  );
}
