import { regionObservedAnswerSchema, REGION_MAX_BROKERS } from '../regions/region-schemas.js';

export const REGION_PUBLICATION_DEFAULTS = Object.freeze({ enabled:false, tickIntervalMs:10000,
  publishTimeoutMs:5000, retryBaseMs:60000, retryMaxMs:3600000 });
const integer = (minimum,maximum) => ({ type:'integer',minimum,maximum });
const object = (properties,required=Object.keys(properties)) => ({ type:'object',additionalProperties:false,properties,required });
const settings = { enabled:{ type:'boolean' },tickIntervalMs:integer(1000,60000),
  publishTimeoutMs:integer(1000,5000),retryBaseMs:integer(1000,86400000),retryMaxMs:integer(1000,604800000) };
export const regionPublicationFileSchema = object(settings,[]);
export const regionPublicationConfigSchema = object(settings);
export const regionPublicationBrokerIdsSchema = { type:'array',maxItems:REGION_MAX_BROKERS,uniqueItems:true,
  items:{ type:'string',minLength:1,maxLength:256 } };
const key = { type:'string',pattern:'^[0-9A-F]{64}$',minLength:64,maxLength:64 };
export const regionPublicationSourceSchema = object({ observerPublicKey:key,targetPublicKey:key,answer:regionObservedAnswerSchema });
export const regionPublicationPayloadSchema = object({ type:{ const:'REGIONS' },
  timestamp:{ type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' },
  target:{ ...key,pattern:'^[0-9a-f]{64}$' },regions:regionObservedAnswerSchema.properties.regions,
  truncated:{ const:true },repeater_clock:integer(0,0xFFFFFFFF) },['type','timestamp','target','regions','truncated']);
export const regionTransportSchema = object({ brokerId:regionPublicationBrokerIdsSchema.items,
  topic:{ type:'string',pattern:'^meshcore/client/[0-9a-f]{64}/regions$' },
  payload:regionPublicationPayloadSchema,timeoutMs:settings.publishTimeoutMs });
export const regionTransportResultSchema = object({ outcome:{ enum:['sent','failed','skipped'] } });
