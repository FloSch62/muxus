import type { HostUpsertRequest, SavedHostProfile, SavedHostProfileInput } from '@muxus/shared';
import { draftToRequest, draftToSavedSshInput, type HostDraft } from './draft.js';

/** The requests a range save makes; the editor passes the real API calls. */
export interface RangeSaveSteps {
  /** Every new ssh_config host in one write, so `.muxus.bak` predates the save. */
  createConfigHosts: (requests: HostUpsertRequest[]) => Promise<unknown>;
  saveProfile: (input: SavedHostProfileInput) => Promise<SavedHostProfile>;
  /** Folder, colour, logging and the rest, saved next to a host that exists. */
  saveSettings: (draft: HostDraft, profile: SavedHostProfile | undefined) => Promise<void>;
}

export interface RangeSaveReport {
  total: number;
  /** Hosts that exist now, in order. */
  created: string[];
  /** The first saved Muxus profile, for Save & connect. */
  firstProfile?: SavedHostProfile;
  /** Creating stopped at this host; it and the ones after it do not exist. */
  stopped?: { name: string; error: unknown };
  /** Hosts that exist but whose settings could not be saved. */
  missingSettings: { name: string; error: unknown }[];
}

/**
 * Create every host of a range, then save each one's settings. ssh_config
 * hosts are written in one request, so they all exist or none do; Muxus
 * profiles are created one by one and stop at the first failure. A settings
 * failure does not stop the rest: the host exists, and the report names it.
 */
export async function saveHostRange(
  drafts: HostDraft[],
  steps: RangeSaveSteps,
  onProgress: (message: string) => void = () => {},
): Promise<RangeSaveReport> {
  const report: RangeSaveReport = { total: drafts.length, created: [], missingSettings: [] };
  const profiles: (SavedHostProfile | undefined)[] = [];

  if (drafts[0]?.storage === 'openssh') {
    onProgress(`Writing ${drafts.length} hosts to ssh_config…`);
    try {
      await steps.createConfigHosts(drafts.map((draft) => draftToRequest(draft)));
    } catch (error) {
      report.stopped = { name: drafts[0].aliasText, error };
      return report;
    }
    for (const draft of drafts) {
      report.created.push(draft.aliasText);
      profiles.push(undefined);
    }
  } else {
    for (const [i, draft] of drafts.entries()) {
      onProgress(`Creating ${draft.aliasText} (${i + 1} of ${drafts.length})…`);
      try {
        const profile = await steps.saveProfile(draftToSavedSshInput(draft));
        report.created.push(draft.aliasText);
        profiles.push(profile);
        report.firstProfile ??= profile;
      } catch (error) {
        report.stopped = { name: draft.aliasText, error };
        break;
      }
    }
  }

  for (const [i, name] of report.created.entries()) {
    onProgress(`Saving settings for ${name} (${i + 1} of ${report.created.length})…`);
    try {
      await steps.saveSettings(drafts[i]!, profiles[i]);
    } catch (error) {
      report.missingSettings.push({ name, error });
    }
  }
  return report;
}

export interface RangeSaveSummary {
  severity: 'success' | 'warning' | 'error';
  message: string;
  /** The first error behind a warning, for the toast's details. */
  detail?: string;
}

export function summarizeRangeSave(report: RangeSaveReport): RangeSaveSummary {
  const created = report.created.length;
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (created === 0) {
    return {
      severity: 'error',
      message: 'No hosts were created.',
      detail: report.stopped ? reason(report.stopped.error) : undefined,
    };
  }
  const parts: string[] = [];
  if (report.stopped) {
    parts.push(`Created ${created} of ${report.total} hosts, then stopped at ${report.stopped.name}.`);
  } else {
    parts.push(`Created ${created} hosts.`);
  }
  if (report.missingSettings.length > 0) {
    const names = report.missingSettings.map((entry) => entry.name);
    const listed = names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
    parts.push(`Folder, colour and logging settings were not saved for ${listed} — edit them to set these.`);
  }
  const failure = report.stopped?.error ?? report.missingSettings[0]?.error;
  return failure === undefined
    ? { severity: 'success', message: parts.join(' ') }
    : { severity: 'warning', message: parts.join(' '), detail: reason(failure) };
}
