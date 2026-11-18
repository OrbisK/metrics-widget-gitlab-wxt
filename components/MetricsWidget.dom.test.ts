// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import MetricsWidget from './MetricsWidget.vue';
import { compareMetrics, mergeMetrics, toParsedReport } from '@/lib/metrics';
import { DEFAULT_SETTINGS } from '@/lib/storage';
import type { PipelineProgress, ScanResult } from '@/lib/types';

const finished: PipelineProgress = {
  unfinishedJobs: [],
  manualJobs: [],
  jobNames: ['metrics'],
  awaitingDownstream: false,
};

function report(text: string, jobId: number) {
  const jobWebUrl = `https://gitlab.example/g/p/-/jobs/${jobId}`;
  return toParsedReport(text, {
    jobId,
    jobName: 'metrics',
    jobWebUrl,
    downloadUrl: `${jobWebUrl}/artifacts/download?file_type=metrics`,
  });
}

let app: App | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = '';
});

describe('MetricsWidget in the page', () => {
  it('expands to every change, biggest first, when the largest change is clicked', async () => {
    const head = [report('a 110\nb 50\nc 300\nd 1', 1)];
    const base = [report('a 100\nb 100\nc 200', 2)];
    const result: ScanResult = {
      reports: head,
      metrics: mergeMetrics(head),
      pipelineId: 99,
      pipelineWebUrl: 'https://gitlab.example/g/p/-/pipelines/99',
      progress: finished,
      comparison: {
        status: 'ready',
        comparison: {
          base: { strategy: 'merge-base', pipelineId: 55, targetBranch: 'main' },
          ...compareMetrics(head, base, finished),
        },
      },
    };

    const root = document.createElement('div');
    document.body.append(root);
    app = createApp(() =>
      h(MetricsWidget, {
        state: { status: 'ok', result },
        // Both off, to show the click works without either.
        settings: { ...DEFAULT_SETTINGS, startCollapsed: true, showFilter: false },
      }),
    );
    app.mount(root);

    expect(root.querySelector('.glmw-body')).toBeNull();

    root.querySelector<HTMLButtonElement>('.glmw-largest')!.click();
    await nextTick();
    await nextTick();

    const input = root.querySelector<HTMLInputElement>('.glmw-input')!;
    expect(input.value).toBe('is:changed sort:abs-change');
    expect(document.activeElement).toBe(input);
    const names = [...root.querySelectorAll('.glmw-name')].map((cell) => cell.textContent?.trim());
    expect(names).toEqual(['b', 'c', 'a']);
  });
});
