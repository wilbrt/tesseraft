export const FieldList = ({ fields }: { fields: Array<[string, unknown]> }) => (
  <dl>
    {fields.map(([label, value]) => (
      <div className="field-row" key={label}>
        <dt>{label}</dt>
        <dd>{String(value ?? '')}</dd>
      </div>
    ))}
  </dl>
);
