import type { ServiceConfig } from 'caretaker-types';

/** Enabled `email` records that can both read (IMAP) and send (SMTP) — what a triage run needs. */
export function triageAccountOptions(services: ServiceConfig[]): ServiceConfig[] {
  return services.filter(s => s.type === 'email' && s.enabled && !!s.imapHost && !!s.smtpHost);
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
    return 'The selected email account is not available (it must be enabled with both IMAP and SMTP).';
  }
  if (!f.recipients.split(/[,\n]/).some(r => r.trim())) return 'Add at least one recipient for the triage report.';
  const n = Number(f.maxEmails);
  if (!/^\d+$/.test(f.maxEmails.trim()) || n < 1 || n > 50) return 'Max emails must be a whole number between 1 and 50.';
  return null;
}
