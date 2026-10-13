import {
  bestEffortDiagnostic,
  recordProviderDiagnostic,
  recordProviderFailureDiagnostic,
} from "../diagnostics/events";
import type { DiagnosticSource } from "../shared/diagnostics-types";
import type { ProviderJobResult } from "../shared/organizer-types";
import {
  generateValidatedProposal,
  type GenerateProposalOptions,
} from "./generate-proposal";

export async function generateProposalWithDiagnostics(
  options: GenerateProposalOptions,
  source: DiagnosticSource,
): Promise<ProviderJobResult> {
  const startedAt = Date.now();
  try {
    const result = await generateValidatedProposal(options);
    await bestEffortDiagnostic(() => recordProviderDiagnostic(options.config, result, source));
    return result;
  } catch (error) {
    await bestEffortDiagnostic(() =>
      recordProviderFailureDiagnostic(options.config, source, startedAt, error),
    );
    throw error;
  }
}
