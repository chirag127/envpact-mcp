import path from 'node:path';
import {
  loadVault,
  saveVault,
  pullVault,
  commitAndPushVault,
  detectProjectFromGit,
  ensureProjectExists,
} from '../lib/vault.js';
import { resolveProject } from '../lib/resolver.js';
import { parseEnvExample, renderEnv, writeEnvAtomic, ensureGitignoreCovers } from '../lib/envwriter.js';

function ok(text, structured) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

function err(message, structured) {
  const out = {
    isError: true,
    content: [{ type: 'text', text: `error: ${message}` }],
  };
  if (structured) out.structuredContent = structured;
  return out;
}

export async function generateEnvHandler(args) {
  try {
    const cwdAbs = path.resolve(args.working_directory || process.cwd());
    const outputAbs = path.resolve(cwdAbs, args.output_path || '.env');
    const rel = path.relative(cwdAbs, outputAbs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return err('output_path must resolve inside working_directory');
    }

    const project = (args.project_name || detectProjectFromGit(cwdAbs)).toLowerCase();
    const examplePath = path.join(cwdAbs, '.env.example');

    pullVault();
    const vault = loadVault();
    ensureProjectExists(vault, project);

    const requiredKeys = parseEnvExample(examplePath);
    const result = resolveProject(vault, project, args.environment);

    if (result.encrypted && result.encrypted.length > 0) {
      return err(
        `Cannot write .env: ${result.encrypted.length} key(s) are encrypted ` +
          `(${result.encrypted.join(', ')}). The MCP server does not decrypt; ` +
          `run \`envpact pull\` (envpact-cli) on a host with the age identity to ` +
          `materialise this .env.`,
        {
          project,
          environment: result.environment,
          encrypted: result.encrypted,
        }
      );
    }

    const orderedKeys = requiredKeys.length ? requiredKeys : Object.keys(result.resolved);
    const missingKeys = orderedKeys.filter((k) => !(k in result.resolved));

    const content = renderEnv(orderedKeys, result.resolved, {
      environment: result.environment,
      project,
    });
    writeEnvAtomic(outputAbs, content);
    ensureGitignoreCovers(cwdAbs, '.env');

    return ok(
      `Wrote ${Object.keys(result.resolved).length} keys to ${outputAbs} ` +
        `(env=${result.environment}, project=${project}). ` +
        (missingKeys.length
          ? `${missingKeys.length} key(s) still missing: ${missingKeys.join(', ')}. ` +
            `Use add_secret to provide them.`
          : 'All keys resolved.'),
      {
        project,
        environment: result.environment,
        output_path: outputAbs,
        resolved_count: Object.keys(result.resolved).length,
        missing: missingKeys,
        unresolved: result.unresolved,
        invalid: result.invalid,
      }
    );
  } catch (e) {
    return err(e.message);
  }
}
