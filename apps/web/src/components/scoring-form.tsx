import { useState } from 'react';
import type { ScoringInput } from '../api/tierforge';
import { validateScoringInput } from '../utils/scoring';

type InputField = keyof ScoringInput;

interface MetricConfigurationProps {
  title: string;
  description: string;
  barLabel: string;
  barField: 'footfallBar' | 'revenueBar' | 'sizeBar';
  weightField: 'footfallWeight' | 'revenueWeight' | 'sizeWeight';
  values: ScoringInput;
  errors: Partial<Record<InputField | 'weights', string>>;
  onChange(field: InputField, value: string): void;
}

export function MetricConfiguration({
  title,
  description,
  barLabel,
  barField,
  weightField,
  values,
  errors,
  onChange,
}: MetricConfigurationProps) {
  return (
    <fieldset className="rounded-xl border border-slate-200 bg-slate-50/70 p-5">
      <legend className="sr-only">{title} configuration</legend>
      <div className="mb-4">
        <h3 className="font-semibold text-slate-950">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={barLabel}
          field={barField}
          value={values[barField]}
          error={errors[barField]}
          onChange={onChange}
        />
        <Field
          label="Weight (%)"
          field={weightField}
          value={values[weightField]}
          error={errors[weightField]}
          onChange={onChange}
          max="100"
        />
      </div>
    </fieldset>
  );
}

function Field({
  label,
  field,
  value,
  error,
  onChange,
  max,
}: {
  label: string;
  field: InputField;
  value: string;
  error?: string | undefined;
  max?: string | undefined;
  onChange(field: InputField, value: string): void;
}) {
  const id = `scoring-${field}`;
  return (
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
      <input
        id={id}
        name={field}
        type="number"
        min="0"
        max={max}
        step="0.01"
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-slate-950 shadow-sm outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-100"
      />
      {error && (
        <span id={`${id}-error`} className="mt-1 block text-xs text-rose-700">
          {error}
        </span>
      )}
    </label>
  );
}

interface ScoringFormProps {
  initialValues: ScoringInput;
  isSubmitting: boolean;
  submitError?: string | undefined;
  revision: number | null;
  onSubmit(values: ScoringInput): void;
}

export function ScoringForm({
  initialValues,
  isSubmitting,
  submitError,
  revision,
  onSubmit,
}: ScoringFormProps) {
  const [values, setValues] = useState(initialValues);
  const validation = validateScoringInput(values);
  function change(field: InputField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  return (
    <form
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.valid) onSubmit(values);
      }}
    >
      <div className="mb-6 flex flex-col justify-between gap-3 border-b border-slate-100 pb-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">Metric configuration</h2>
          <p className="mt-1 text-sm text-slate-500">
            A metric contributes its full weight when it meets or exceeds its bar.
          </p>
        </div>
        {revision && (
          <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            Current revision {revision}
          </span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <MetricConfiguration
          title="Footfall"
          description="Estimated monthly store visitors."
          barLabel="Monthly footfall bar"
          barField="footfallBar"
          weightField="footfallWeight"
          values={values}
          errors={validation.errors}
          onChange={change}
        />
        <MetricConfiguration
          title="Revenue"
          description="Estimated monthly store revenue."
          barLabel="Monthly revenue bar"
          barField="revenueBar"
          weightField="revenueWeight"
          values={values}
          errors={validation.errors}
          onChange={change}
        />
        <MetricConfiguration
          title="Store size"
          description="Physical retail footprint."
          barLabel="Store size bar (sqft)"
          barField="sizeBar"
          weightField="sizeWeight"
          values={values}
          errors={validation.errors}
          onChange={change}
        />
      </div>

      <div className="mt-6 grid gap-4 rounded-xl border border-slate-200 p-5 sm:grid-cols-2">
        <Field
          label="Large tier threshold"
          field="largeThreshold"
          value={values.largeThreshold}
          error={validation.errors.largeThreshold}
          onChange={change}
          max="100"
        />
        <Field
          label="Medium tier threshold"
          field="mediumThreshold"
          value={values.mediumThreshold}
          error={validation.errors.mediumThreshold}
          onChange={change}
          max="100"
        />
      </div>

      <div
        className={`mt-5 flex flex-col gap-2 rounded-xl px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${validation.weightTotal === 100 ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900'}`}
      >
        <span className="text-sm font-semibold">Total metric weight</span>
        <span className="text-lg font-bold">{validation.weightTotal.toFixed(2)}%</span>
      </div>
      {validation.errors.weights && (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {validation.errors.weights}
        </p>
      )}
      {submitError && (
        <p
          role="alert"
          className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {submitError}
        </p>
      )}

      <div className="mt-7 flex flex-col justify-end gap-3 sm:flex-row sm:items-center">
        <p className="mr-auto text-xs leading-5 text-slate-500">
          Recalculation uses persisted enrichment results and creates a new scoring revision.
        </p>
        <button
          type="submit"
          disabled={!validation.valid || isSubmitting}
          className="rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isSubmitting
            ? 'Calculating scores…'
            : revision
              ? 'Recalculate scores'
              : 'Calculate scores'}
        </button>
      </div>
    </form>
  );
}
