export interface WizardScreenProps {
  readonly onBack: () => void;
}

export function WizardScreen({ onBack }: WizardScreenProps) {
  return (
    <section className="screen" aria-labelledby="wizard-title">
      <h2 id="wizard-title">Kreator nowej floty</h2>
      <p className="muted">Kreator floty pojawi się tutaj.</p>
      <div className="actions">
        <button type="button" onClick={onBack}>
          Wróć
        </button>
      </div>
    </section>
  );
}
