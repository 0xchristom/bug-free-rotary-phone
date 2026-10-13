export interface StartScreenProps {
  readonly onCreate: () => void;
  readonly onOpen: () => void;
}

export function StartScreen({ onCreate, onOpen }: StartScreenProps) {
  return (
    <section className="screen" aria-labelledby="start-title">
      <h2 id="start-title">Welcome to Bunndly</h2>
      <p>Create a new fleet of wallets or open a saved fleet file.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onCreate}>
          Create a new fleet
        </button>
        <button type="button" onClick={onOpen}>
          Open a fleet file
        </button>
      </div>
    </section>
  );
}
