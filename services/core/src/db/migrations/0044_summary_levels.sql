-- HO1: a compaction is kept at three sizes for the same cut (a line, a paragraph, a page), each
-- tagged with the window class of the model it was made for, so every model reads the finest one
-- its window holds and a bigger model goes back to finer levels or the full turns. Summaries made
-- before this are the page size, with no window recorded.
alter table core.summaries add column if not exists level text not null default 'page';
alter table core.summaries add column if not exists for_window integer not null default 0;
