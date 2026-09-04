"use client";

import { useState, type ReactNode } from "react";
import LineSidebar from "@/components/LineSidebar";

export type DashboardNavItem = {
  id: string;
  label: string;
  badge?: number;
  content: ReactNode;
};

export function DashboardSidebarNav({ items, header }: { items: DashboardNavItem[]; header?: ReactNode }) {
  const [activeId, setActiveId] = useState(items[0]?.id);
  const active = items.find((item) => item.id === activeId) ?? items[0];

  const labels = items.map((item) => (item.badge ? `${item.label} · ${item.badge}` : item.label));

  return (
    <div className="dashboard-app-shell">
      <aside className="dashboard-sidebar" aria-label="Dashboard sections">
        <LineSidebar
          items={labels}
          accentColor="#8f83ff"
          textColor="#9aa2c0"
          markerColor="#4d5273"
          showIndex
          showMarker
          proximityRadius={90}
          maxShift={12}
          falloff="smooth"
          markerLength={18}
          markerGap={8}
          tickScale={0.5}
          scaleTick
          itemGap={22}
          fontSize={0.95}
          smoothing={120}
          defaultActive={0}
          onItemClick={(index) => setActiveId(items[index]?.id)}
        />
      </aside>
      <div className="dashboard-content">
        {header}
        <div className="dashboard-content-section">{active?.content}</div>
      </div>
    </div>
  );
}
