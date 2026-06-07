// tests/unit/compliance/dnd-classifier.service.spec.ts
import { DndClassifierService } from '../../../src/compliance/dnd/dnd-classifier.service';

describe('DndClassifierService', () => {
  let service: DndClassifierService;

  beforeEach(() => {
    service = new DndClassifierService();
  });

  describe('classify', () => {
    it('should classify RISK-001 as TRANSACTIONAL', () => {
      expect(service.classify('RISK-001')).toBe('TRANSACTIONAL');
    });

    it('should classify RISK-002 as TRANSACTIONAL', () => {
      expect(service.classify('RISK-002')).toBe('TRANSACTIONAL');
    });

    it('should classify TXNX-001 as TRANSACTIONAL', () => {
      expect(service.classify('TXNX-001')).toBe('TRANSACTIONAL');
    });

    it('should classify TXNX-002 as TRANSACTIONAL', () => {
      expect(service.classify('TXNX-002')).toBe('TRANSACTIONAL');
    });

    it('should classify SIPX-002 as TRANSACTIONAL', () => {
      expect(service.classify('SIPX-002')).toBe('TRANSACTIONAL');
    });

    it('should classify SIPX-003 as TRANSACTIONAL', () => {
      expect(service.classify('SIPX-003')).toBe('TRANSACTIONAL');
    });

    it('should classify SIPX-001 as PROMOTIONAL', () => {
      expect(service.classify('SIPX-001')).toBe('PROMOTIONAL');
    });

    it('should classify SIPX-004 as PROMOTIONAL', () => {
      expect(service.classify('SIPX-004')).toBe('PROMOTIONAL');
    });

    it('should classify SIPX-005 as PROMOTIONAL', () => {
      expect(service.classify('SIPX-005')).toBe('PROMOTIONAL');
    });

    it('should classify MKTX-001 as PROMOTIONAL', () => {
      expect(service.classify('MKTX-001')).toBe('PROMOTIONAL');
    });

    it('should classify MKTX-003 as PROMOTIONAL', () => {
      expect(service.classify('MKTX-003')).toBe('PROMOTIONAL');
    });

    it('should classify REGX-002 as PROMOTIONAL', () => {
      expect(service.classify('REGX-002')).toBe('PROMOTIONAL');
    });

    it('should classify REGX-005 as PROMOTIONAL', () => {
      expect(service.classify('REGX-005')).toBe('PROMOTIONAL');
    });
  });

  describe('isTransactional', () => {
    it('should return true for margin call events', () => {
      expect(service.isTransactional('RISK-001')).toBe(true);
      expect(service.isTransactional('RISK-002')).toBe(true);
      expect(service.isTransactional('RISK-003')).toBe(true);
    });

    it('should return false for promotional events', () => {
      expect(service.isTransactional('SIPX-001')).toBe(false);
      expect(service.isTransactional('MKTX-003')).toBe(false);
    });
  });

  describe('isPromotional', () => {
    it('should return true for market update events', () => {
      expect(service.isPromotional('MKTX-001')).toBe(true);
      expect(service.isPromotional('MKTX-003')).toBe(true);
      expect(service.isPromotional('MKTX-004')).toBe(true);
    });

    it('should return false for transactional events', () => {
      expect(service.isPromotional('RISK-001')).toBe(false);
      expect(service.isPromotional('TXNX-001')).toBe(false);
    });
  });
});
