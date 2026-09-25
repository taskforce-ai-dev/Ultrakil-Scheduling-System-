import { ApiError, fetchCustomers, type Customer, type CustomerQuery } from "@/lib/api-client";

/**
 * The API's own ceiling (`PaginationQueryDto`, `apps/api/src/workforce/dto/query.dto.ts`
 * — `@Max(200)`). Asking for more is refused, so this is the largest number of
 * round trips we can save per page.
 */
export const CUSTOMER_PAGE_SIZE = 200;

/**
 * 10,000 customers. Far past any real book of work, and only ever reached if
 * the server stops advancing — at which point looping forever is the worse
 * failure. Bounded so a selector can fail loudly instead of hanging.
 */
const MAX_PAGES = 50;

export class IncompleteCustomerListError extends ApiError {
  constructor(loaded: number, expected: number) {
    super({
      code: "CUSTOMER_LIST_INCOMPLETE",
      message:
        `Only ${loaded} of ${expected} customers could be loaded, so this list would be ` +
        `incomplete. Reload to try again.`,
      details: { loaded, expected },
    });
    this.name = "IncompleteCustomerListError";
  }
}

/**
 * Every customer, not the first page of them.
 *
 * A selector that quietly stops at the first page is worse than one that
 * fails: the customer is simply absent, the manager concludes the record does
 * not exist, and nothing anywhere says otherwise. So this walks the pages to
 * the API's stated `total` and refuses to return a partial list — a thrown
 * error surfaces in the page's existing error state, which is visible, where
 * silent truncation is not.
 *
 * Two server-side failures are treated as errors rather than as an end of
 * data:
 *
 * - a page that comes back empty while rows are still owed, and
 * - a page whose rows we have all already seen, which means paging is not
 *   advancing and looping would never terminate.
 */
export async function loadAllCustomers(
  query: Omit<CustomerQuery, "page" | "pageSize"> = {},
): Promise<Customer[]> {
  const collected: Customer[] = [];
  const seen = new Set<string>();
  let expected = 0;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchCustomers({ ...query, page, pageSize: CUSTOMER_PAGE_SIZE });
    // Trust the newest total: a customer added mid-walk moves it, and the page
    // cap above is what stops that from looping.
    expected = response.total;

    const fresh = response.items.filter((customer) => !seen.has(customer.id));
    for (const customer of fresh) {
      seen.add(customer.id);
      collected.push(customer);
    }

    if (collected.length >= expected) return collected;

    // Rows are still owed. An empty page, or a page that repeated rows we
    // already hold, both mean the next request would return the same thing.
    if (response.items.length === 0 || fresh.length === 0) {
      throw new IncompleteCustomerListError(collected.length, expected);
    }
  }

  throw new IncompleteCustomerListError(collected.length, expected);
}
