# Security Considerations

## Overview

`padd` handles sensitive credentials for multiple service providers. This document outlines security practices, recommendations, and potential risks.

## Credential Storage

### Auth File Format

Credentials are stored in `auth.enc.json`:

```json
{
  "providers": {
    "ms-graph": { "access_token": "...", "username": "..." },
    "confluence": { "api_token": "...", "base_url": "..." }
  }
}
```

### File Permissions

**Default Behavior**:
- Auth files created with `chmod 600` (owner read/write only)
- Permission warnings displayed if file is group/world-readable
- Automatic permission check on load

**Recommendation**: Always verify permissions after manual edits:
```bash
chmod 600 auth.enc.json
```

### Encryption Options

padd supports **optional** encryption via git-crypt:

**Without git-crypt** (default):
- Auth file stored as plaintext JSON
- Protected by filesystem permissions
- `.gitignore` prevents accidental commits (if no git-crypt detected)

**With git-crypt** (recommended for teams):
```bash
# Setup git-crypt in your repo
git-crypt init
echo "*.enc.* filter=git-crypt diff=git-crypt" >> .gitattributes
git add .gitattributes
git-crypt add-gpg-user YOUR_GPG_KEY

# Auth file now encrypted on git push
git add auth.enc.json
git commit -m "Add encrypted auth"
```

padd detects git-crypt and:
- Skips adding `*.enc.*` to `.gitignore` (encrypted files safe to commit)
- Displays helpful warnings if not unlocked
- Does NOT force git-crypt usage

## Credential Refresh

### Interactive Prompts

`padd auth refresh` uses interactive prompts for credential entry:

- **MS Graph**: Paste OAuth token from Graph Explorer
- **Confluence**: Enter API token or PAT
- **AWS**: Enter Access Key ID + Secret
- **GitHub**: Enter Personal Access Token

**Security Notes**:
- Password fields use output masking (shows `***`)
- Tokens stored in memory only during prompt
- No network transmission (direct paste from browser)

### Token Expiration

Different providers have different expiration policies:

| Provider   | Token Type | Expires | Refresh Method |
|------------|------------|---------|----------------|
| MS Graph   | OAuth      | 1 hour  | Manual re-paste |
| Confluence | API Token  | Never*  | Regenerate if compromised |
| AWS        | Access Key | Never*  | Rotate manually |
| GitHub     | PAT        | Configurable | Regenerate if compromised |

*Unless revoked or rotated

**Recommendation**: Use short-lived tokens when possible. Rotate regularly.

## Transmission Security

### HTTPS Only

All API clients use HTTPS exclusively:
- Confluence: `https://` required in base URL
- SharePoint: MS Graph API is HTTPS-only
- No fallback to HTTP

### Authentication Headers

- Confluence: Basic Auth (Base64 encoded) or Bearer token (PAT)
- SharePoint: Bearer token (OAuth)
- Headers logged only at debug level (never in production)

## Common Attack Vectors

### 1. Credential Theft

**Risk**: Auth file stolen from filesystem

**Mitigations**:
- File permissions (600)
- Optional git-crypt encryption
- Regular token rotation
- No credentials in environment variables

### 2. Accidental Commit

**Risk**: Auth file committed to public repo

**Mitigations**:
- Auto-generated `.gitignore` (if no git-crypt)
- `.enc.` suffix convention (visual indicator)
- Pre-commit hooks (user responsibility)

**Recovery**: If credentials committed:
1. Immediately revoke all tokens in auth file
2. Remove file from git history (`git filter-branch` or BFG)
3. Regenerate all credentials
4. Force push to overwrite history

### 3. Token Replay

**Risk**: Stolen token used by attacker

**Mitigations**:
- Short token lifespans (MS Graph: 1 hour)
- IP restrictions (configure in provider console)
- Activity monitoring (provider responsibility)

### 4. Man-in-the-Middle

**Risk**: Network traffic intercepted

**Mitigations**:
- HTTPS mandatory
- Certificate validation (Node.js default)
- No custom CA certificates

## Best Practices

### For Individuals

1. **Use short-lived tokens** when possible (MS Graph OAuth)
2. **Set chmod 600** on all `.enc.` files
3. **Never** share auth files via Slack/email/etc.
4. **Rotate credentials** quarterly or after team changes
5. **Use separate tokens** for different projects/environments

### For Teams

1. **Use git-crypt** for shared repos
2. **Restrict GPG keys** to team members only
3. **Audit git-crypt users** when team members leave
4. **Separate tokens** per environment (dev/staging/prod)
5. **Document rotation policy** in team wiki

### For CI/CD

**DO NOT** commit auth files to CI:

```yaml
# GitHub Actions example
- name: Configure padd
  run: |
    echo '${{ secrets.PADD_AUTH }}' > auth.enc.json
    chmod 600 auth.enc.json
    padd config validate
```

Store credentials in:
- GitHub Secrets
- AWS Secrets Manager
- Azure Key Vault
- HashiCorp Vault

## Audit Trail

padd maintains metadata in auth files:

```json
{
  "_meta": {
    "version": "1.0",
    "last_updated": "2026-04-17T12:34:56.789Z"
  },
  "providers": {
    "ms-graph": {
      "last_refreshed": "2026-04-17T12:34:56.789Z",
      "_updated_at": "2026-04-17T12:34:56.789Z"
    }
  }
}
```

Use `padd auth info` to check:
- When tokens were last refreshed
- Which providers are configured
- Token expiration status

## Reporting Security Issues

**DO NOT** open public GitHub issues for security vulnerabilities.

Contact: lucas.dasso@vml.com

Include:
- Description of vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

Response time: 48 hours

## Compliance

### GDPR
- Auth files may contain email addresses (MS Graph username)
- User responsible for data handling compliance
- No telemetry or analytics sent to padd maintainers

### SOC 2 / ISO 27001
- padd does not store credentials on external servers
- All data local to user's filesystem
- Use git-crypt for at-rest encryption
- Configure provider console for access logging

## Security Checklist

Before deploying:
- [ ] Auth files have chmod 600
- [ ] `.enc.*` files in .gitignore (or encrypted with git-crypt)
- [ ] Tokens have minimal required permissions
- [ ] Separate tokens for dev/prod
- [ ] Team members trained on credential handling
- [ ] Rotation schedule documented
- [ ] Backup/recovery plan exists
- [ ] CI/CD uses secret management
- [ ] Activity monitoring enabled (provider side)
- [ ] Incident response plan documented
