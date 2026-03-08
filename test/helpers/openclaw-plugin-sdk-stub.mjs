export function stringEnum(values) {
  return {
    type: "string",
    enum: Array.isArray(values) ? values : [],
  };
}

