import { FREE_VEHICLE_CHECKS_PER_MONTH } from "@/domain/free-check-quota";

/**
 * One line beside the home search. Numbers come from the free-check allotment.
 * Find needs a report credit. An empty search does not charge.
 */
export const HOME_ACCOUNT_LINE = `Searches and checks run through a free account: ${FREE_VEHICLE_CHECKS_PER_MONTH} free VIN or listing checks per verified account each UTC month. Find needs a report credit and charges nothing when no car is found.`;
