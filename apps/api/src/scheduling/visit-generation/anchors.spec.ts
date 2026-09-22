import { anchorDaysFrom } from './anchors';

/**
 * Where in the month an agreement's work usually falls.
 *
 * Read from the dates UltraKIL has already booked, so a month the workbook
 * does not cover still lands roughly where the customer expects it rather
 * than on the first allowed weekday of the month.
 */
describe('anchorDaysFrom', () => {
  it('takes the median day of month for a once-a-month agreement', () => {
    expect(
      anchorDaysFrom(['2026-01-10', '2026-02-12', '2026-03-09'], 1),
    ).toEqual([10]);
  });

  it('keeps "the 5th and the 20th" as two anchors, in order', () => {
    expect(
      anchorDaysFrom(
        ['2026-01-05', '2026-01-20', '2026-02-05', '2026-02-19', '2026-03-06', '2026-03-20'],
        2,
      ),
    ).toEqual([5, 20]);
  });

  it('ranks the bookings inside each month, so a late first visit does not swap them', () => {
    // February's pair is written the wrong way round in the workbook.
    expect(
      anchorDaysFrom(['2026-01-04', '2026-01-21', '2026-02-21', '2026-02-04'], 2),
    ).toEqual([4, 21]);
  });

  it('averages the two middle days of an even sample', () => {
    expect(anchorDaysFrom(['2026-01-10', '2026-02-13'], 1)).toEqual([12]);
  });

  it('asks for no more anchors than the agreement has visits', () => {
    expect(
      anchorDaysFrom(['2026-01-05', '2026-01-12', '2026-01-20'], 1),
    ).toEqual([5]);
  });

  it('drops an anchor no month has a booking for', () => {
    // Two visits a month on paper, one booked date a month in practice.
    expect(anchorDaysFrom(['2026-01-14', '2026-02-16'], 2)).toEqual([15]);
  });

  it('has no anchor to offer when nothing is booked', () => {
    expect(anchorDaysFrom([], 1)).toEqual([]);
  });
});
