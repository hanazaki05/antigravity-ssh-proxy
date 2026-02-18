import * as fs from 'fs';
import * as path from 'path';

export function generateSetupScript(proxyHost: string, proxyPort: number, proxyType: string, extensionPath: string): string {
    const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');
    let script = fs.readFileSync(scriptPath, 'utf-8');

    // Replace placeholders
    script = script.replace(/__PROXY_HOST__/g, proxyHost);
    script = script.replace(/__PROXY_PORT__/g, String(proxyPort));
    script = script.replace(/__PROXY_TYPE__/g, proxyType);

    return script;
}

export function generateRollbackScript(): string {
    return `#!/bin/bash
set -e

# Find all backup files and restore them
BAKS=$(find "$HOME/.antigravity-server" -path "*/extensions/antigravity/bin/*" -name "language_server_linux_*.bak" -type f 2>/dev/null)
[ -z "$BAKS" ] && echo "Nothing to rollback" && exit 0

RESTORED=0
while IFS= read -r BAK; do
    [ -z "$BAK" ] && continue
TARGET="\${BAK%.bak}"
    echo "Restoring: $TARGET"
[ -f "$TARGET" ] && rm -f "$TARGET"
mv "$BAK" "$TARGET"
    RESTORED=$((RESTORED + 1))
done <<< "$BAKS"

echo "Rollback complete: $RESTORED file(s) restored"
`;
}
