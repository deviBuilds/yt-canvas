import { createContext, useContext } from "react";

import type { AccountUser } from "./api";

export interface AccountValue {
  /** Accounts are on (Clerk); false in no-login mode. */
  accounts: boolean;
  /** Who is signed in; null in no-login mode. */
  user: AccountUser | null;
  signOut: () => void;
}

const NO_LOGIN: AccountValue = { accounts: false, user: null, signOut: () => undefined };

export const AccountContext = createContext<AccountValue>(NO_LOGIN);

export function useAccount(): AccountValue {
  return useContext(AccountContext);
}
