"use client";

import {
  Bar,
  BarChart,
  Cell,
  Label,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const GRID = "rgba(132,145,196,.16)";
const AXIS = "#a7aecb";
const TOOLTIP_STYLE = {
  background: "rgba(14,17,30,.97)",
  border: "1px solid rgba(132,145,196,.28)",
  borderRadius: 10,
  color: "#f5f6ff",
  fontSize: 13,
  boxShadow: "0 12px 32px rgba(0,0,0,.4)",
};
const PIE_COLORS = ["#8f83ff", "#4d9bff", "#2fd0a4", "#f5b23f", "#ee6579", "#8b93b8"];

const BREAKDOWN_COLORS: Record<string, string> = {
  Recovered: "#2fd0a4",
  "Attributed to AI": "#8f83ff",
  "Still at risk": "#f5b23f",
};

export function RecoveryBreakdownChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 20, right: 8, left: -8, bottom: 0 }}>
        <XAxis dataKey="name" stroke={AXIS} fontSize={12.5} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis stroke={AXIS} fontSize={12} tickLine={false} axisLine={false} width={52} tickFormatter={(v) => `₹${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: "rgba(124,111,255,.08)" }}
          formatter={(value) => [`₹${Number(value).toLocaleString("en-IN")}`, ""]}
        />
        <Bar dataKey="value" barSize={56} radius={[6, 6, 0, 0]} isAnimationActive={false}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={BREAKDOWN_COLORS[entry.name] ?? "#8f83ff"} />
          ))}
          <LabelList dataKey="value" position="top" formatter={(v: number) => `₹${v.toLocaleString("en-IN")}`} fill="#e2e4f5" fontSize={12} fontWeight={600} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ObligationStatusChart({ data }: { data: { name: string; value: number }[] }) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <div className="flex items-center gap-6">
      <ResponsiveContainer width={150} height={150}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={46} outerRadius={68} paddingAngle={2} stroke="none" isAnimationActive={false}>
            {data.map((entry, i) => (
              <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />
            ))}
            <Label
              position="center"
              content={() => (
                <text x={75} y={75} textAnchor="middle" dominantBaseline="middle">
                  <tspan x={75} dy={-4} fontSize={22} fontWeight={700} fill="#ffffff">{total}</tspan>
                  <tspan x={75} dy={18} fontSize={11} fill="#9aa2c0">total</tspan>
                </text>
              )}
            />
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value, name) => [`${value} (${total > 0 ? ((Number(value) / total) * 100).toFixed(0) : 0}%)`, name]}
          />
        </PieChart>
      </ResponsiveContainer>
      <ul className="space-y-2 text-sm">
        {data.map((entry, i) => (
          <li key={entry.name} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
            <span className="text-neutral-400">{entry.name}</span>
            <span className="font-semibold text-neutral-100">{entry.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FailureBreakdownChart({ data }: { data: { name: string; value: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(150, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" stroke={AXIS} fontSize={12.5} tickLine={false} axisLine={false} width={120} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(124,111,255,.1)" }} />
        <Bar dataKey="value" fill="#8f83ff" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
          <LabelList dataKey="value" position="right" fill="#e2e4f5" fontSize={12} fontWeight={600} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
