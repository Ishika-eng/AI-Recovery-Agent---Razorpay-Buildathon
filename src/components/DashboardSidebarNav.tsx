"use client";

import { useState, type ReactNode } from "react";

export type DashboardNavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: number;
  content: ReactNode;
};

export function DashboardSidebarNav({ items, header }: { items: DashboardNavItem[]; header?: ReactNode }) {
  const [activeId, setActiveId] = useState(items[0]?.id);
  const active = items.find((item) => item.id === activeId) ?? items[0];

  return (
    <div className="dashboard-app-shell">
      <aside className="dashboard-sidebar" aria-label="Dashboard sections">
        <nav className="dashboard-sidebar-nav">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`dashboard-sidebar-item ${item.id === active?.id ? "is-active" : ""}`}
              onClick={() => setActiveId(item.id)}
            >
              <span className="dashboard-sidebar-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="dashboard-sidebar-label">{item.label}</span>
              {!!item.badge && <span className="dashboard-sidebar-badge">{item.badge}</span>}
            </button>
          ))}
        </nav>
      </aside>
      <div className="dashboard-content">
        {header}
        <div className="dashboard-content-section">{active?.content}</div>
      </div>
    </div>
  );
}
