export type UserProtectionRule =
  | {
      id: string;
      kind: "location";
      pattern: string;
      createdAt: number;
    }
  | {
      id: string;
      kind: "group_title";
      pattern: string;
      createdAt: number;
    };

export interface SessionUserProtections {
  tabIds: number[];
  groupIds: number[];
}

export interface UserProtectionState {
  permanentRules: UserProtectionRule[];
  session: SessionUserProtections;
}
