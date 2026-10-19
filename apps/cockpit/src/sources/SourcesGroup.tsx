/**
 * ------------------------------------------------------------------
 *  Title    |  Settings, Sources
 *  Ref      |  ROADMAP SR1 · docs/knowledge.md (Scanned PDFs)
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  The choice behind "Enable OCR in Settings → Sources":
 *           |  read the pages of a scanned PDF on this computer so
 *           |  they can be searched and cited, in the language of
 *           |  the scan.
 *  How      |  GET and PUT /knowledge/ocr. The switch writes at
 *           |  once; the language is saved when you leave the field.
 *           |  The group says which OCR engines this computer has and
 *           |  what to install when it has none.
 *  Note     |  Off by default: OCR is slow on a long scan. A single
 *           |  failed source can still be read with OCR from its own
 *           |  card, whatever this says.
 * ------------------------------------------------------------------
 */

import type { OcrView } from '@nvx/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { Block, matches, SearchContext } from '../routes/settings/rows';
import { notify } from '../state/notify';
import { Switch } from '../ui/controls';
import { LoadFailed } from '../ui/LoadFailed';
import { Skeleton } from '../ui/primitives';

export const OCR_KEY = ['knowledge', 'ocr'] as const;
const KEYWORDS =
  'ocr scan scanned pdf image text recognise recognize tesseract rapidocr language handwriting';
const LABEL = 'Read scanned PDFs with OCR';

/** Languages offered by name; any other code still works typed in as it is. */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ru', label: 'Russian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (simplified)' },
];

/** What this computer can do, in a sentence, with what to install when it has no engine. */
export function enginesWords(i: OcrView['installed']): string {
  if (i.rapidocr && i.tesseract) return 'RapidOCR and Tesseract are installed.';
  if (i.rapidocr)
    return 'RapidOCR is installed. It reads Latin letters and Chinese; for other scripts install Tesseract.';
  if (i.tesseract) return 'Tesseract is installed.';
  return 'No OCR engine is installed yet. Install RapidOCR (uv pip install rapidocr-onnxruntime) or Tesseract, then turn this on.';
}

export function SourcesGroup() {
  const q = useContext(SearchContext);
  const ocr = useQuery({ queryKey: OCR_KEY, queryFn: () => api.get<OcrView>('/knowledge/ocr') });
  const save = useMutation({
    mutationFn: (v: { enabled: boolean; language: string }) => api.put<OcrView>('/knowledge/ocr', v),
    onSuccess: (next) => queryClient.setQueryData(OCR_KEY, next),
    onError: () =>
      notify({
        level: 'error',
        title: 'The OCR setting was not saved',
        body: 'Check that NVX Ancile and its knowledge service are running, then try again.',
      }),
  });
  const [language, setLanguage] = useState('en');
  useEffect(() => {
    if (ocr.data) setLanguage(ocr.data.language);
  }, [ocr.data]);
  if (!matches(q, LABEL, KEYWORDS)) return null;
  const data = ocr.data;
  const engineless = !!data && !data.installed.rapidocr && !data.installed.tesseract;
  return (
    <Block title="Scanned PDFs" lede="Pages that are pictures of text can be read on this computer.">
      <div className="setting">
        <div className="setting__words">
          <div className="setting__label">
            <span>{LABEL}</span>
          </div>
          <p className="setting__desc">
            A page with no text layer is read with OCR, page by page, and shown as you add the source. Pages
            that already have text are left alone, so citations still land on the right page. Handwriting is
            read poorly. A long scan takes a while; you can keep working.
          </p>
          {data ? <p className="setting__desc mute">{enginesWords(data.installed)}</p> : null}
        </div>
        <div className="setting__control">
          {ocr.isError ? (
            <LoadFailed error={ocr.error} what="The OCR setting" onRetry={() => ocr.refetch()} compact />
          ) : !data ? (
            <Skeleton lines={1} />
          ) : (
            <Switch
              label={LABEL}
              checked={data.enabled}
              disabled={engineless && !data.enabled}
              onChange={(enabled) => save.mutate({ enabled, language: data.language })}
            />
          )}
        </div>
      </div>
      <div className="setting">
        <div className="setting__words">
          <div className="setting__label">
            <label htmlFor="ocr-language">Language of your scans</label>
          </div>
          <p className="setting__desc">
            Pick the language the scans are written in. Several can be joined with +, for example en+de.
            Languages other than Latin letters and Chinese need Tesseract with that language installed.
          </p>
        </div>
        <div className="setting__control">
          <input
            id="ocr-language"
            className="input"
            list="ocr-languages"
            value={language}
            disabled={!data}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setLanguage(e.target.value)}
            onBlur={() => {
              const next = language.trim().toLowerCase();
              if (data && next && next !== data.language)
                save.mutate({ enabled: data.enabled, language: next });
              else if (data) setLanguage(data.language);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
          <datalist id="ocr-languages">
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </datalist>
        </div>
      </div>
    </Block>
  );
}
