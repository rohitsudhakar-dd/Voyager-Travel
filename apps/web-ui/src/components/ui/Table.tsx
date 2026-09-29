import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface TableColumn<T> {
  id: string;
  header: string;
  /** Right-align numbers; they scan far better. */
  align?: 'left' | 'right';
  sortable?: boolean;
  width?: string;
  render: (row: T) => React.ReactNode;
}

export interface TableProps<T> {
  caption: string;
  columns: TableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  sort?: { columnId: string; direction: 'asc' | 'desc' };
  onSortChange?: (columnId: string) => void;
  zebra?: boolean;
  /** Tighter rows for the Ops console. */
  dense?: boolean;
  stickyHeader?: boolean;
  emptyMessage?: string;
  testId?: string;
  className?: string;
}

export function Table<T>({
  caption,
  columns,
  rows,
  getRowKey,
  sort,
  onSortChange,
  zebra,
  dense,
  stickyHeader,
  emptyMessage = 'Nothing to show',
  testId = 'table',
  className,
}: TableProps<T>) {
  const cellPadding = dense ? 'px-3 py-1.5' : 'px-4 py-3';

  return (
    <div className={cn('overflow-x-auto rounded-lg border border-border', className)}>
      <table data-testid={testId} className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead className={cn('bg-bg-sunken', stickyHeader && 'sticky top-0 z-10')}>
          <tr>
            {columns.map((column) => {
              const sorted = sort?.columnId === column.id;
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={{ width: column.width }}
                  aria-sort={
                    sorted ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={cn(
                    'border-b border-border text-heading-sm text-fg-muted',
                    cellPadding,
                    column.align === 'right' && 'text-right',
                  )}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      data-testid={`${testId}-sort-${column.id}`}
                      onClick={() => onSortChange(column.id)}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-fg',
                        sorted && 'text-fg',
                      )}
                    >
                      {column.header}
                      {sorted ? (
                        sort.direction === 'asc' ? (
                          <ChevronUp aria-hidden className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown aria-hidden className="h-3.5 w-3.5" />
                        )
                      ) : null}
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className={cn('text-center text-fg-muted', cellPadding)}>
                {emptyMessage}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={getRowKey(row)}
                className={cn(
                  'border-b border-border last:border-b-0',
                  zebra && index % 2 === 1 && 'bg-bg-sunken/50',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className={cn(
                      'text-body-md text-fg',
                      cellPadding,
                      column.align === 'right' && 'text-right',
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
