export interface StartScreenProps {
  readonly onCreate: () => void;
  readonly onOpen: () => void;
}

export function StartScreen({ onCreate, onOpen }: StartScreenProps) {
  return (
    <section className="screen" aria-labelledby="start-title">
      <h2 id="start-title">Witaj w Bunndly</h2>
      <p>Utwórz nową flotę portfeli albo otwórz zapisany plik floty.</p>
      <div className="actions">
        <button type="button" className="primary" onClick={onCreate}>
          Utwórz nową flotę
        </button>
        <button type="button" onClick={onOpen}>
          Otwórz plik floty
        </button>
      </div>
    </section>
  );
}
