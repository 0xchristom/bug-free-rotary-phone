import { Button } from '../kit/index.ts';
export interface StartScreenProps {
  readonly onCreate: () => void;
  readonly onOpen: () => void;
}

export function StartScreen({ onCreate, onOpen }: StartScreenProps) {
  return (
    <section className="screen narrow panel hero" aria-labelledby="start-title">
      <h2 id="start-title">Welcome to Bunndly</h2>
      <p>Create a new fleet of wallets or open a saved fleet file.</p>
      <div className="actions">
        <Button variant="primary" onClick={onCreate}>
          Create a new fleet
        </Button>
        <Button onClick={onOpen}>Open a fleet file</Button>
      </div>
    </section>
  );
}
