/**
 * generate_global_env tool — writes `~/.envpact/.env` from
 * `~/.envpact/.env.example.global`, mirroring every shared.* entry
 * in the vault per SHARED_SPEC §1.6 / §5.1 (v3.1 additive UX).
 *
 * Inputs:
 *   - output_path?: string   — override target file (default
 *                              ~/.envpact/.env). The example
 *                              template is always
 *                              ~/.envpact/.env.example.global; we
 *                              don't expose an override here so the
 *                              dashboard / VS Code agree with us.
 *
 * Returns:
 *   {
 *     output_path,
 *     resolved_count,
 *     encrypted,                      // list of shared keys with enc:* values
 *     not_in_vault,                   // keys present in example but missing in vault
 *     generated_global_example,       // true if we just created the example template
 *   }
 *
 * NEVER returns secret values. Same security stance as
 * generate_env.
 */

import { loadVault, pullVault } from '../lib/vault.js';
import { generateGlobalEnv } from '../lib/global-env.js';

function ok(text, structured) {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function err(message, structured) {
  const out = { isError: true, content: [{ type: 'text', text: `error: ${message}` }] };
  if (structured) out.structuredContent = structured;
  return out;
}

export async function generateGlobalEnvHandler(args = {}) {
  try {
    pullVault();
    const vault = loadVault();

    const result = generateGlobalEnv(vault, {
      outputPath: typeof args.output_path === 'string' && args.output_path.length > 0
        ? args.output_path
        : undefined,
    });

    const summaryParts = [
      `Wrote ${result.resolved_count} shared key(s) to ${result.output_path}.`,
    ];
    if (result.encrypted.length) {
      summaryParts.push(
        `${result.encrypted.length} encrypted (decrypt via envpact-cli): ${result.encrypted.join(', ')}.`
      );
    }
    if (result.not_in_vault.length) {
      summaryParts.push(
        `${result.not_in_vault.length} not in vault: ${result.not_in_vault.join(', ')}.`
      );
    }
    if (result.generated_global_example) {
      summaryParts.push(
        'Created ~/.envpact/.env.example.global (alphabetical, no comments) on this run.'
      );
    }

    return ok(summaryParts.join(' '), result);
  } catch (e) {
    return err(e.message);
  }
}
