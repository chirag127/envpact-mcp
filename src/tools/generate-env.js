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

function err(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `error: ${message}` }],
  };
}

export async function generateEnvHandler(args) {
  try {
    const cwd = args.working_directory || process.cwd();
    const project = (args.project_name || detectProjectFromGit(cwd)).toLowerCase();
    const examplePath = path.join(cwd, '.env.example');
    const outputPath = path.join(cwd, args.output_path || '.env');

    pullVault();
    const vault = loadVault();
    ensureProjectExists(vault, project);

    const requiredKeys = parseEnvExample(examplePath);
    const result = resolveProject(vault, project, args.environment);

    const orderedKeys = requiredKeys.length ? requiredKeys : Object.keys(result.resolved);
    const missingKeys = orderedKeys.filter((k) => !(k in result.resolved));

    const content = renderEnv(orderedKeys, result.resolved, {
      environment: result.environment,
      project,
    });
    writeEnvAtomic(outputPath, content);
    ensureGitignoreCovers(cwd, '.env');

    return ok(
      `Wrote ${Object.keys(result.resolved).length} keys to ${outputPath} ` +
        `(env=${result.environment}, project=${project}). ` +
        (missingKeys.length
          ? `${missingKeys.length} key(s) still missing: ${missingKeys.join(', ')}. ` +
            `Use add_secret to provide them.`
          : 'All keys resolved.'),
      {
        project,
        environment: result.environment,
        output_path: outputPath,
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
