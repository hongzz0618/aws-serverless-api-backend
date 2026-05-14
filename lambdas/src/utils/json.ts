type ParseJsonResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
    };

export const parseJson = (body: string): ParseJsonResult => {
  try {
    return {
      ok: true,
      value: JSON.parse(body),
    };
  } catch {
    return {
      ok: false,
    };
  }
};
