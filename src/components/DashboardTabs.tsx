"use client";

import { useState, type ReactNode } from "react";

export type DashboardTab = {
  id: string;
  label: string;
  badge?: number;
  content: ReactNode;
};

export function DashboardTabs({ tabs }: { tabs: DashboardTab[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div>
      <div className="dashboard-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active?.id}
            className={`dashboard-tab ${tab.id === active?.id ? "is-active" : ""}`}
            onClick={() => setActiveId(tab.id)}
          >
            {tab.label}
            {!!tab.badge && <span className="dashboard-tab-badge">{tab.badge}</span>}
          </button>
        ))}
      </div>
      <div className="dashboard-tabpanel" role="tabpanel">
        {active?.content}
      </div>
    </div>
  );
}
