/**
 * FeedbackConfigManager — Proposal A v3 Phase 3
 * Provides configurable feedback amplitudes for dynamic importance adjustment.
 */
export interface FeedbackConfig {
  importanceBoostOnUse: number;      // default: 0.05
  importanceBoostOnConfirm: number; // default: 0.15
  importancePenaltyOnMiss: number; // default: 0.03
  importancePenaltyOnError: number; // default: 0.10
  minRecallCountForPenalty: number; // default: 2
  minRecallCountForBoost: number;   // default: 1
  confirmKeywords: string[];
  errorKeywords: string[];
}

export class FeedbackConfigManager {
  constructor(private config: FeedbackConfig) {}

  /**
   * Compute the importance delta for a given event.
   * @param event 'use' | 'confirm' | 'miss' | 'error'
   * @param recallCount - number of times this memory was recalled (injected_count)
   * @param badRecallCount - current bad_recall_count
   */
  computeImportanceDelta(
    event: 'use' | 'confirm' | 'miss' | 'error',
    recallCount: number = 1,
    badRecallCount: number = 0,
  ): number {
    if (event === 'use') {
      if (recallCount < this.config.minRecallCountForBoost) return 0;
      return this.config.importanceBoostOnUse;
    }
    if (event === 'confirm') {
      return this.config.importanceBoostOnConfirm;
    }
    if (event === 'miss') {
      if (recallCount < this.config.minRecallCountForPenalty) return 0;
      return -this.config.importancePenaltyOnMiss;
    }
    if (event === 'error') {
      return -this.config.importancePenaltyOnError;
    }
    return 0;
  }

  isConfirmKeyword(text: string): boolean {
    return this.config.confirmKeywords.some(k =>
      text.toLowerCase().includes(k.toLowerCase()),
    );
  }

  isErrorKeyword(text: string): boolean {
    return this.config.errorKeywords.some(k =>
      text.toLowerCase().includes(k.toLowerCase()),
    );
  }

  static defaultConfig(): FeedbackConfig {
    return {
      importanceBoostOnUse: 0.05,
      importanceBoostOnConfirm: 0.15,
      importancePenaltyOnMiss: 0.03,
      importancePenaltyOnError: 0.10,
      minRecallCountForPenalty: 2,
      minRecallCountForBoost: 1,
      confirmKeywords: ['是對的', '確認', '正確', 'right'],
      errorKeywords: ['錯誤', '不對', 'wrong', 'not right'],
    };
  }

  static fromRaw(raw?: Record<string, unknown> | null): FeedbackConfigManager {
    const cfg = raw ?? {};
    return new FeedbackConfigManager({
      importanceBoostOnUse:
        typeof cfg.importanceBoostOnUse === 'number' ? cfg.importanceBoostOnUse : 0.05,
      importanceBoostOnConfirm:
        typeof cfg.importanceBoostOnConfirm === 'number' ? cfg.importanceBoostOnConfirm : 0.15,
      importancePenaltyOnMiss:
        typeof cfg.importancePenaltyOnMiss === 'number' ? cfg.importancePenaltyOnMiss : 0.03,
      importancePenaltyOnError:
        typeof cfg.importancePenaltyOnError === 'number' ? cfg.importancePenaltyOnError : 0.10,
      minRecallCountForPenalty:
        typeof cfg.minRecallCountForPenalty === 'number' ? cfg.minRecallCountForPenalty : 2,
      minRecallCountForBoost:
        typeof cfg.minRecallCountForBoost === 'number' ? cfg.minRecallCountForBoost : 1,
      confirmKeywords: Array.isArray(cfg.confirmKeywords) ? cfg.confirmKeywords : ['是對的', '確認', '正確', 'right'],
      errorKeywords: Array.isArray(cfg.errorKeywords) ? cfg.errorKeywords : ['錯誤', '不對', 'wrong', 'not right'],
    });
  }
}