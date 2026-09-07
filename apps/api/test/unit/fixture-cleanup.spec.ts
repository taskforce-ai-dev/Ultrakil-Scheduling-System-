import { cleanupCapturedIds } from '../support/fixture-cleanup';

describe('partial fixture setup cleanup', () => {
  it('does not execute a delete when setup captured no ID', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    await cleanupCapturedIds([undefined, null, ''], remove);
    expect(remove).not.toHaveBeenCalled();
  });

  it('passes only captured IDs when setup fails part way through', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    await cleanupCapturedIds(['captured-id', undefined, ''], remove);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(['captured-id']);
  });
});
