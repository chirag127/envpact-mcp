import { loadVault, pullVault } from '../lib/vault.js';
import { ENC_PREFIX } from '../lib/resolver.js';

export async function listSharedHandler() {
  try {
    pullVault();
    const vault = loadVault();
    const items = Object.entries(vault.shared || {})
      .map(([name, value]) => ({
        name,
        encrypted: typeof value === 'string' && value.startsWith(ENC_PREFIX),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      content: [
        {
          type: 'text',
          text: items.length
            ? `${items.length} shared secret(s) (values masked):\n` +
              items.map((i) => `  ${i.name}  ${i.encrypted ? '(encrypted)' : '(plain)'}`).join('\n')
            : '(no shared secrets yet)',
        },
      ],
      structuredContent: { shared: items },
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `error: ${e.message}` }] };
  }
}
