import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  switchZcodePlan,
  getZcodePlanInfo,
  formatResetTime,
} from '../src/agents/zcode.js';

describe('ZCode plan management', () => {
  function makeTempZcodeDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-test-'));
    const prov = {
      defaultModelSelection: {
        providerId: 'account:zai-individual-coding-plan',
        modelId: 'GLM-5.3',
      },
    };
    const sett = {
      modelProviderFamilySelectedKeys: {
        zai: 'coding-plan:builtin:zai-coding-plan',
      },
      providerFamilyConnectionSelections: {
        zai: { kind: 'individual-coding-plan' },
      },
      providerFamilyDomain: 'zai',
    };
    const cfg = {
      provider: {
        'builtin:zai-coding-plan': {
          enabled: true,
          options: { apiKey: 'sub-test-key' },
        },
        'builtin:zai-start-plan': {
          enabled: false,
          options: { apiKey: 'start-test-key' },
        },
      },
    };

    fs.writeFileSync(path.join(tmp, 'provider_config.json'), JSON.stringify(prov, null, 2));
    fs.writeFileSync(path.join(tmp, 'setting.json'), JSON.stringify(sett, null, 2));
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg, null, 2));

    return tmp;
  }

  it('switches plan from subscription to free tokens', () => {
    const tmp = makeTempZcodeDir();
    try {
      switchZcodePlan('free', tmp);

      const prov = JSON.parse(fs.readFileSync(path.join(tmp, 'provider_config.json'), 'utf8'));
      expect(prov.defaultModelSelection.providerId).toBe('account:zai-start-plan');
      expect(prov.defaultModelSelection.modelId).toBe('GLM-5.3-Flash');

      const sett = JSON.parse(fs.readFileSync(path.join(tmp, 'setting.json'), 'utf8'));
      expect(sett.modelProviderFamilySelectedKeys.zai).toBe('coding-plan:builtin:zai-start-plan');
      expect(sett.providerFamilyConnectionSelections.zai.kind).toBe('start-plan');

      const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      expect(cfg.provider['builtin:zai-start-plan'].enabled).toBe(true);
      expect(cfg.provider['builtin:zai-coding-plan'].enabled).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('switches plan from free tokens to subscription', () => {
    const tmp = makeTempZcodeDir();
    try {
      // First switch to free
      switchZcodePlan('free', tmp);
      // Then switch back to subscription
      switchZcodePlan('subscription', tmp);

      const prov = JSON.parse(fs.readFileSync(path.join(tmp, 'provider_config.json'), 'utf8'));
      expect(prov.defaultModelSelection.providerId).toBe('account:zai-individual-coding-plan');

      const sett = JSON.parse(fs.readFileSync(path.join(tmp, 'setting.json'), 'utf8'));
      expect(sett.modelProviderFamilySelectedKeys.zai).toBe('coding-plan:builtin:zai-coding-plan');
      expect(sett.providerFamilyConnectionSelections.zai.kind).toBe('individual-coding-plan');

      const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      expect(cfg.provider['builtin:zai-coding-plan'].enabled).toBe(true);
      expect(cfg.provider['builtin:zai-start-plan'].enabled).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads plan info and identifies active plan', async () => {
    const tmp = makeTempZcodeDir();
    try {
      const info = await getZcodePlanInfo(tmp);
      expect(info.activePlanId).toBe('subscription');
      expect(info.plans).toHaveLength(2);
      expect(info.plans[0].id).toBe('subscription');
      expect(info.plans[0].active).toBe(true);
      expect(info.plans[1].id).toBe('free');
      expect(info.plans[1].active).toBe(false);

      // Now switch to free and re-check
      switchZcodePlan('free', tmp);
      const freeInfo = await getZcodePlanInfo(tmp);
      expect(freeInfo.activePlanId).toBe('free');
      expect(freeInfo.plans[0].active).toBe(false);
      expect(freeInfo.plans[1].active).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws descriptive error if provider config does not exist', () => {
    expect(() => switchZcodePlan('free', '/nonexistent/path/here')).toThrow(/not found/);
  });

  it('formats reset times accurately across different windows', () => {
    const now = 1790795414614; // fixed timestamp
    expect(formatResetTime(undefined, now)).toBeUndefined();
    expect(formatResetTime(0, now)).toBeUndefined();
    expect(formatResetTime(-100, now)).toBeUndefined();
    expect(formatResetTime(now - 1000, now)).toBe('abgelaufen');
    expect(formatResetTime(now + 30 * 60000, now)).toContain('(in 30m)');
    expect(formatResetTime(now + 90 * 60000, now)).toContain('(in 1h 30m)');
    expect(formatResetTime(now + 120 * 60000, now)).toContain('(in 2h)');
    expect(formatResetTime(now + 26 * 3600000, now)).toContain('Morgen');
    expect(formatResetTime(now + 26 * 3600000, now)).toContain('(in 26h)');
    expect(formatResetTime(now + 6 * 86400000, now)).toContain('(in 6d)');
  });
});
