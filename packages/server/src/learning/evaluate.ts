import type { DecisionDataset, DecisionPrediction, RecoveryChoice } from '@motif/core';
import { validateDataset } from './dataset.js';

export function evaluateDataset(
  dataset: DecisionDataset,
  supplied?: { datasetHash: string; predictions: DecisionPrediction[] },
) {
  validateDataset(dataset);
  const train = dataset.examples.filter((e) => e.split === 'train');
  const test = dataset.examples.filter((e) => e.split === 'test');
  if (!train.length || !test.length)
    throw new Error('Insufficient independent groups for held-out evaluation (need at least two).');
  const choices: RecoveryChoice[] = ['retry_unchanged', 'revise_command'];
  const majority = [...choices].sort(
    (a, b) =>
      train.filter((e) => e.target.choice === b).length - train.filter((e) => e.target.choice === a).length,
  )[0]!;
  const predictions = new Map<string, DecisionPrediction>();
  if (supplied) {
    if (supplied.datasetHash !== dataset.manifest.datasetHash || !Array.isArray(supplied.predictions))
      throw new Error('Predictions must name this dataset hash');
    const testIds = new Set(test.map((e) => e.id));
    for (const p of supplied.predictions) {
      if (!p || !testIds.has(p.id) || predictions.has(p.id))
        throw new Error('Unknown or duplicate prediction id');
      predictions.set(p.id, p);
    }
  } else for (const e of test) predictions.set(e.id, { id: e.id, choice: majority });
  let correct = 0,
    answered = 0,
    invalid = 0,
    missing = 0,
    abstained = 0;
  const confusion = choices.map((choice) => ({ choice, support: 0, tp: 0, fp: 0, fn: 0, f1: 0 }));
  for (const e of test) {
    const p = predictions.get(e.id);
    let selected: RecoveryChoice | undefined;
    if (!p) missing++;
    else if (p.abstain === true && p.choice === undefined) abstained++;
    else if (p.abstain === true || !choices.includes(p.choice as RecoveryChoice)) invalid++;
    else {
      selected = p.choice;
      answered++;
    }
    if (selected === e.target.choice) correct++;
    for (const c of confusion) {
      if (e.target.choice === c.choice) {
        c.support++;
        if (selected === c.choice) c.tp++;
        else c.fn++;
      } else if (selected === c.choice) c.fp++;
    }
  }
  for (const c of confusion) c.f1 = (2 * c.tp) / (2 * c.tp + c.fp + c.fn || 1);
  return {
    datasetHash: dataset.manifest.datasetHash,
    model: supplied ? 'external-predictions' : 'majority',
    targetBasis: 'observed-behavior',
    train: train.length,
    test: test.length,
    accuracy: correct / test.length,
    selectiveAccuracy: answered ? correct / answered : null,
    coverage: answered / test.length,
    macroF1: confusion.reduce((n, c) => n + c.f1, 0) / choices.length,
    invalid,
    missing,
    abstained,
    perChoice: confusion,
    observedOutcomes: {
      successful: test.filter((e) => e.experience.outcome?.success).length,
      unsuccessful: test.filter((e) => e.experience.outcome?.success === false).length,
    },
    limitation:
      'Measures agreement with recorded behavior, not optimal choices or causal improvement in task success.',
  };
}
