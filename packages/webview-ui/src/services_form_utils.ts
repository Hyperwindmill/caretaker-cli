import type { ServiceConfig } from 'caretaker-types';

/** Enabled `email` records that can both read (IMAP) and send (SMTP) — what a triage run needs. */
export function triageAccountOptions(services: ServiceConfig[], agentId: string): ServiceConfig[] {
  return services.filter(
    s =>
      s.type === 'email' &&
      s.enabled &&
      !!s.imapHost &&
      !!s.smtpHost &&
      (!s.allowedAgents?.length || s.allowedAgents.includes(agentId)),
  );
}

/** Same separators as the server's parseRecipients: comma, semicolon, newline. */
export function splitRecipients(raw: string | undefined): string[] {
  return (raw || '').split(/[,\n;]/).map(r => r.trim()).filter(Boolean);
}

/** Form-level check for an `email_triage` service. UX feedback only; null = valid. */
export function triageFormError(
  f: { agentId: string; cron: string; accountId: string; recipients: string; maxEmails: string },
  accounts: ServiceConfig[],
): string | null {
  if (!f.agentId) return 'Please select an agent for this service.';
  if (f.cron.trim().split(/\s+/).filter(Boolean).length !== 5) {
    return 'Invalid cron expression. It must contain exactly 5 space-separated fields (e.g. "*/15 * * * *").';
  }
  if (!f.accountId) return 'Select the email account to triage.';
  if (!accounts.some(a => a.id === f.accountId)) {
    return 'The selected email account is not available (it must be enabled, have IMAP and SMTP, and be open to the selected agent).';
  }
  if (splitRecipients(f.recipients).length === 0) return 'Add at least one recipient for the triage report.';
  const n = Number(f.maxEmails);
  if (!/^\d+$/.test(f.maxEmails.trim()) || n < 1 || n > 200) return 'Max emails must be a whole number between 1 and 200.';
  return null;
}
