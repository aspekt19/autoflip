import { FREE_VEHICLE_CHECKS_PER_MONTH } from "@/domain/free-check-quota";

/**
 * One line beside the home search. Numbers come from the free-check allotment.
 * Find is credit-priced per delivered search — it is not part of
 * the monthly free checks.
 */
export const HOME_ACCOUNT_LINE = `Searches and checks run through a free account: ${FREE_VEHICLE_CHECKS_PER_MONTH} free VIN or listing checks per verified account each UTC month. Find costs 1 report credit per delivered search.`;
