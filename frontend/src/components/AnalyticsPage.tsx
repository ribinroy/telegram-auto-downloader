import { useState, useEffect } from 'react';
import { ArrowLeft, Loader2, Download, CheckCircle, XCircle, TrendingUp, HardDrive, Calendar, Clock } from 'lucide-react';
import { fetchAnalytics } from '../api';
import { formatBytes } from '../utils/format';
import type { AnalyticsData } from '../types';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';

interface AnalyticsPageProps {
  onBack: () => void;
}

const COLORS = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#6366f1', '#14b8a6'];

export function AnalyticsPage({ onBack }: AnalyticsPageProps) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [groupBy, setGroupBy] = useState<'day' | 'hour'>('day');

  useEffect(() => {
    loadAnalytics();
  }, [days, groupBy]);

  const loadAnalytics = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAnalytics(days, groupBy);
      setData(result);
    } catch (err) {
      setError('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  };

  const formatLabel = (label: string) => {
    if (groupBy === 'hour') {
      // Format: "2024-01-15 14:00" -> "Jan 15 14:00"
      const date = new Date(label.replace(' ', 'T'));
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
             date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    // Format: "2024-01-15" -> "Jan 15"
    const date = new Date(label);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const formatHour = (hour: number) => {
    return `${hour.toString().padStart(2, '0')}:00`;
  };

  // Prepare source data for pie chart (top 5 + others)
  const getSourceChartData = () => {
    if (!data) return [];
    const sources = data.by_source;
    if (sources.length <= 6) {
      return sources.map(s => ({ name: s.source, value: s.count }));
    }
    const top5 = sources.slice(0, 5);
    const othersCount = sources.slice(5).reduce((sum, s) => sum + s.count, 0);
    return [
      ...top5.map(s => ({ name: s.source, value: s.count })),
      { name: 'Others', value: othersCount }
    ];
  };

  // Prepare status data for pie chart
  const getStatusChartData = () => {
    if (!data) return [];
    return Object.entries(data.by_status).map(([status, count]) => ({
      name: status.charAt(0).toUpperCase() + status.slice(1),
      value: count
    }));
  };

  const STATUS_COLORS: Record<string, string> = {
    'Done': '#10b981',
    'Downloading': '#06b6d4',
    'Failed': '#ef4444',
    'Stopped': '#f59e0b',
  };

  return (
    <div className="h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex flex-col overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 py-6 w-full flex flex-col flex-1 min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="p-2 bg-slate-700/50 hover:bg-slate-600/50 text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-2xl font-bold text-white">Analytics</h1>
              <p className="text-slate-400 text-sm">Download statistics and trends</p>
            </div>
          </div>

          {/* Period selector */}
          <div className="flex items-center gap-3">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as 'day' | 'hour')}
              className="bg-slate-700/50 border border-slate-600 rounded-lg py-2 px-3 text-sm text-white focus:outline-none focus:border-cyan-500"
            >
              <option value="day">By Day</option>
              <option value="hour">By Hour</option>
            </select>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-red-400">
            {error}
          </div>
        ) : data ? (
          <div className="flex-1 min-h-0 overflow-auto space-y-6 pb-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <Download className="w-4 h-4" />
                  Total Downloads
                </div>
                <div className="text-2xl font-bold text-white">{data.summary.total_downloads}</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <HardDrive className="w-4 h-4" />
                  Total Size
                </div>
                <div className="text-2xl font-bold text-white">{formatBytes(data.summary.total_size)}</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <CheckCircle className="w-4 h-4 text-green-400" />
                  Completed
                </div>
                <div className="text-2xl font-bold text-green-400">{data.summary.completed}</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <XCircle className="w-4 h-4 text-red-400" />
                  Failed
                </div>
                <div className="text-2xl font-bold text-red-400">{data.summary.failed}</div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-slate-400 text-sm mb-1">
                  <TrendingUp className="w-4 h-4 text-cyan-400" />
                  Success Rate
                </div>
                <div className="text-2xl font-bold text-cyan-400">{data.summary.success_rate}%</div>
              </div>
            </div>

            {/* Downloads Over Time Chart */}
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-2 text-white font-medium mb-4">
                <Calendar className="w-5 h-5 text-cyan-400" />
                Downloads Over Time
              </div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.time_series}>
                    <defs>
                      <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#06b6d4" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis
                      dataKey="label"
                      tickFormatter={formatLabel}
                      stroke="#64748b"
                      tick={{ fill: '#94a3b8', fontSize: 12 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      stroke="#64748b"
                      tick={{ fill: '#94a3b8', fontSize: 12 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1e293b',
                        border: '1px solid #334155',
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      labelFormatter={formatLabel}
                      formatter={(value: number, name: string) => [
                        name === 'count' ? value : formatBytes(value),
                        name === 'count' ? 'Downloads' : 'Size'
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="count"
                      stroke="#06b6d4"
                      fillOpacity={1}
                      fill="url(#colorCount)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Two Column Layout */}
            <div className="grid md:grid-cols-2 gap-6">
              {/* Downloads by Source */}
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-white font-medium mb-4">
                  <Download className="w-5 h-5 text-purple-400" />
                  Downloads by Source
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={getSourceChartData()}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {getSourceChartData().map((_, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: '8px',
                          color: '#fff'
                        }}
                      />
                      <Legend
                        wrapperStyle={{ color: '#94a3b8', fontSize: '12px' }}
                        formatter={(value) => <span style={{ color: '#94a3b8' }}>{value}</span>}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Downloads by Status */}
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-white font-medium mb-4">
                  <CheckCircle className="w-5 h-5 text-green-400" />
                  Downloads by Status
                </div>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={getStatusChartData()}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {getStatusChartData().map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={STATUS_COLORS[entry.name] || COLORS[index]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: '8px',
                          color: '#fff'
                        }}
                      />
                      <Legend
                        wrapperStyle={{ color: '#94a3b8', fontSize: '12px' }}
                        formatter={(value) => <span style={{ color: '#94a3b8' }}>{value}</span>}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Hourly Distribution */}
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-2 text-white font-medium mb-4">
                <Clock className="w-5 h-5 text-amber-400" />
                Hourly Distribution (All Time)
              </div>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.hourly_distribution}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis
                      dataKey="hour"
                      tickFormatter={formatHour}
                      stroke="#64748b"
                      tick={{ fill: '#94a3b8', fontSize: 11 }}
                    />
                    <YAxis
                      stroke="#64748b"
                      tick={{ fill: '#94a3b8', fontSize: 12 }}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#1e293b',
                        border: '1px solid #334155',
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      labelFormatter={formatHour}
                      formatter={(value: number) => [value, 'Downloads']}
                    />
                    <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Top Sources Table */}
            <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
              <div className="flex items-center gap-2 text-white font-medium mb-4">
                <TrendingUp className="w-5 h-5 text-cyan-400" />
                Top Sources
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-slate-400 text-sm border-b border-slate-700">
                      <th className="text-left py-2 px-3">Source</th>
                      <th className="text-right py-2 px-3">Downloads</th>
                      <th className="text-right py-2 px-3">Total Size</th>
                      <th className="text-right py-2 px-3">Avg Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_source.slice(0, 10).map((source, index) => (
                      <tr key={source.source} className="text-slate-300 border-b border-slate-700/50">
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <div
                              className="w-3 h-3 rounded-full"
                              style={{ backgroundColor: COLORS[index % COLORS.length] }}
                            />
                            {source.source}
                          </div>
                        </td>
                        <td className="text-right py-2 px-3">{source.count}</td>
                        <td className="text-right py-2 px-3">{formatBytes(source.size)}</td>
                        <td className="text-right py-2 px-3">
                          {formatBytes(source.count > 0 ? Math.round(source.size / source.count) : 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
