/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { FormattedMessage } from '@kbn/i18n/react';
import { i18n } from '@kbn/i18n';
import {
  EuiAccordion,
  EuiIconTip,
  EuiPanel,
  EuiSpacer,
  EuiTitle,
  htmlIdGenerator,
} from '@elastic/eui';
import { VectorLayerDescriptor } from '../../../../maps/common/descriptor_types';
import {
  FIELD_ORIGIN,
  SOURCE_TYPES,
  STYLE_TYPE,
  COLOR_MAP_TYPE,
} from '../../../../maps/common/constants';
import { useMlKibana } from '../contexts/kibana';
import { MlEmbeddedMapComponent } from '../components/ml_embedded_map';
import { EMSTermJoinConfig } from '../../../../maps/public';
import { AnomaliesTableRecord } from '../../../common/types/anomalies';

const MAX_ENTITY_VALUES = 3;
const COMMON_EMS_LAYER_IDS = [
  'world_countries',
  'administrative_regions_lvl2',
  'usa_zip_codes',
  'usa_states',
];

function getAnomalyRows(anomalies: AnomaliesTableRecord[], jobId: string) {
  const anomalyRows: Record<
    string,
    { count: number; entityValue: string; max_severity: number }
  > = {};
  for (let i = 0; i < anomalies.length; i++) {
    const anomaly = anomalies[i];
    const location = anomaly.entityValue;
    if (anomaly.jobId !== jobId) continue;

    if (anomalyRows[location] === undefined) {
      // add it to the object and set count to 1
      anomalyRows[location] = {
        count: 1,
        entityValue: location,
        max_severity: Math.floor(anomaly.severity),
      };
    } else {
      anomalyRows[location].count += 1;
      if (anomaly.severity > anomalyRows[location].max_severity) {
        anomalyRows[location].max_severity = Math.floor(anomaly.severity);
      }
    }
  }
  return Object.values(anomalyRows);
}

export const getChoroplethAnomaliesLayer = (
  anomalies: AnomaliesTableRecord[],
  { layerId, field, jobId }: MLEMSTermJoinConfig,
  visible: boolean
): VectorLayerDescriptor => {
  return {
    id: htmlIdGenerator()(),
    label: i18n.translate('xpack.ml.explorer.anomaliesMap.anomaliesCount', {
      defaultMessage: 'Anomalies count: {jobId}',
      values: { jobId },
    }),
    joins: [
      {
        // Left join is the id from the type of field (e.g. world_countries)
        leftField: field,
        right: {
          id: 'anomaly_count',
          type: SOURCE_TYPES.TABLE_SOURCE,
          __rows: getAnomalyRows(anomalies, jobId),
          __columns: [
            {
              name: 'entityValue',
              type: 'string',
            },
            {
              name: 'count',
              type: 'number',
            },
            {
              name: 'max_severity',
              type: 'number',
            },
          ],
          // Right join/term is the field in the doc you’re trying to join it to (foreign key - e.g. US)
          term: 'entityValue',
        },
      },
    ],
    sourceDescriptor: {
      type: 'EMS_FILE',
      id: layerId,
    },
    style: {
      type: 'VECTOR',
      // @ts-ignore missing style properties. Remove once 'VectorLayerDescriptor' type is updated
      properties: {
        icon: { type: STYLE_TYPE.STATIC, options: { value: 'marker' } },
        fillColor: {
          type: STYLE_TYPE.DYNAMIC,
          options: {
            color: 'Blue to Red',
            colorCategory: 'palette_0',
            fieldMetaOptions: { isEnabled: true, sigma: 3 },
            type: COLOR_MAP_TYPE.ORDINAL,
            field: {
              name: 'count',
              origin: FIELD_ORIGIN.JOIN,
            },
            useCustomColorRamp: false,
          },
        },
        lineColor: {
          type: STYLE_TYPE.DYNAMIC,
          options: { fieldMetaOptions: { isEnabled: true } },
        },
        lineWidth: { type: STYLE_TYPE.STATIC, options: { size: 1 } },
      },
      isTimeAware: true,
    },
    visible,
    type: 'VECTOR',
  };
};

interface Props {
  anomalies: AnomaliesTableRecord[];
  jobIds: string[];
}

interface MLEMSTermJoinConfig extends EMSTermJoinConfig {
  jobId: string;
}

export const AnomaliesMap: FC<Props> = ({ anomalies, jobIds }) => {
  const [EMSSuggestions, setEMSSuggestions] = useState<
    Array<MLEMSTermJoinConfig | null> | undefined
  >();
  const {
    services: { maps: mapsPlugin },
  } = useMlKibana();

  const getEMSTermSuggestions = useCallback(async (): Promise<void> => {
    if (!mapsPlugin) return;

    const suggestions = await Promise.all(
      jobIds.map(async (jobId) => {
        const entityValues = new Set<string>();
        let entityName;
        for (let i = 0; i < anomalies.length; i++) {
          if (
            jobId === anomalies[i].jobId &&
            anomalies[i].entityValue !== '' &&
            anomalies[i].entityValue !== undefined &&
            anomalies[i].entityName !== '' &&
            anomalies[i].entityName !== undefined
          ) {
            entityValues.add(anomalies[i].entityValue);

            if (!entityName) {
              entityName = anomalies[i].entityName;
            }
          }

          if (
            // convert to set so it's unique values
            entityValues.size === MAX_ENTITY_VALUES
          )
            break;
        }

        const suggestion: EMSTermJoinConfig | null = await mapsPlugin.suggestEMSTermJoinConfig({
          emsLayerIds: COMMON_EMS_LAYER_IDS,
          sampleValues: Array.from(entityValues),
          sampleValuesColumnName: entityName || '',
        });
        if (suggestion) {
          return { jobId, ...suggestion };
        }
        return suggestion;
      })
    );

    setEMSSuggestions(suggestions.filter((s) => s !== null));
  }, [...jobIds]);

  useEffect(
    function getInitialEMSTermSuggestions() {
      if (anomalies && anomalies.length > 0) {
        getEMSTermSuggestions();
      }
    },
    [...jobIds]
  );

  const layerList = useMemo(() => {
    let layers: VectorLayerDescriptor[] = [];
    // Loop through suggestions list and make a layer for each
    if (EMSSuggestions?.length) {
      let count = 0;
      layers = EMSSuggestions.reduce(function (result, suggestion) {
        if (suggestion) {
          const visible = count === 0;
          result.push(getChoroplethAnomaliesLayer(anomalies, suggestion, visible));
          count++;
        }
        return result;
      }, [] as VectorLayerDescriptor[]);
    }
    return layers;
  }, [EMSSuggestions, anomalies]);

  if (EMSSuggestions?.length === 0) {
    return null;
  }

  return (
    <>
      <EuiPanel>
        <EuiAccordion
          id="mlAnomalyExplorerAnomaliesMapAccordionId"
          initialIsOpen={true}
          buttonContent={
            <EuiTitle className="panel-title">
              <h2>
                <FormattedMessage
                  id="xpack.ml.explorer.mapTitle"
                  defaultMessage="Anomaly count by location {infoTooltip}"
                  values={{
                    infoTooltip: (
                      <EuiIconTip
                        content="Map colors indicate the number of anomalies in each area."
                        position="top"
                        type="iInCircle"
                      />
                    ),
                  }}
                />
              </h2>
            </EuiTitle>
          }
        >
          <div
            data-test-subj="mlAnomalyExplorerAnomaliesMap"
            style={{ width: '100%', height: 300 }}
          >
            <MlEmbeddedMapComponent layerList={layerList} />
          </div>
        </EuiAccordion>
      </EuiPanel>
      <EuiSpacer size="m" />
    </>
  );
};
