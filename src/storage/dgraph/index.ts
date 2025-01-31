import { ExecutionResult } from 'graphql'

import { GraphQLInputData, StorageEngine, StorageEngineConfig } from '../types'
import DGraphClientWrapper from './base'
import { processGQLExecutionResult, UPDATE_SCHEMA_QUERY } from './utils'

export default class DgraphEngine
  extends DGraphClientWrapper
  implements StorageEngine
{
  constructor(config: StorageEngineConfig) {
    super(config)
    this.axiosPromises = []
  }

  axiosPromises: (() => Promise<void>)[]

  async healthCheck(showInitialStatus = true): Promise<boolean> {
    showInitialStatus &&
      this.logger.debug(`running dgraph health check at ${this.host}`)
    try {
      const healthCheck = await this.generateAxiosRequest({
        path: '/health?all',
        headers: {
          'Content-Type': 'application/json',
        },
      })
      this.logger.debug(healthCheck.data)
      return true
    } catch (error: any) {
      this.logger.warn(
        `dgraph at ${this.host} failed health check. Is dgraph running?`
      )
      this.logger.debug(error)
      return false
    }
  }

  async validateSchema(schema: string[], versionString: string): Promise<void> {
    const versionCaption = versionString.split('-').join(' ')
    this.logger.debug(`Validating Schema for ${versionCaption}`)
    return new Promise<void>(async (resolve, reject) => {
      try {
        await this.generateAxiosRequest({
          path: '/admin/schema/validate',
          data: schema.join(),
          headers: {
            'Content-Type': 'text/plain',
          },
        })
        resolve()
      } catch (error: any) {
        const {
          response: {
            data: { errors },
          },
        } = error
        this.logger.error('Schema validation failed')
        const errMsgs = errors.map((e: Error) =>
          e.message.replace('input:', 'line ')
        )
        this.logger.error(
          `${
            errMsgs.length
          } errors found in ${versionCaption} schema. Check the following lines in the schema.graphql file:\n${errMsgs.join(
            '\n'
          )}`
        )
        reject()
      }
    })
  }

  async setSchema(schemas: string[]): Promise<void> {
    await this.dropAll()
    const data = {
      query: UPDATE_SCHEMA_QUERY,
      variables: {
        schema: schemas.join(),
      },
    }
    try {
      await this.generateAxiosRequest({
        path: '/admin',
        data,
      })
        .then((res: ExecutionResult) => {
          const { data: resData, errors } = res
          processGQLExecutionResult({
            reqData: data,
            resData,
            errors,
          })
        })
        .catch(error => Promise.reject(error))
    } catch (error: any) {
      const {
        response: { data: resData, errors },
        message,
      } = error
      this.logger.error(
        'There was an issue pushing the schema into the Dgraph db'
      )
      this.logger.debug(message)
      processGQLExecutionResult({
        reqData: data,
        resData,
        errors,
      })
    }
  }

  /**
   * Add Service Mutation to axiosPromises Array
   */
  push(data: GraphQLInputData): void {
    const { query, connectedData } = data
    const queryData = {
      query,
      variables: {
        input: connectedData,
      },
    }
    this.axiosPromises.push(() =>
      this.generateAxiosRequest({
        path: '/graphql',
        data: queryData,
      })
        .then((res: ExecutionResult) => {
          const { data: resData, errors } = res
          processGQLExecutionResult({
            reqData: queryData,
            resData,
            errors,
            service: data.name
          })
        })
        .catch(error => Promise.reject(error))
    )
  }

  /**
   * Executes mutations sequentially into Dgraph
   */
  async run(dropData = true): Promise<void> {
    dropData && (await this.dropData())
    for (const mutation of this.axiosPromises) {
      try {
        await mutation()
      } catch (error: any) {
        const {
          response: { data: resData, errors },
          message,
        } = error
        this.logger.error('There was an issue pushing data into the Dgraph db')
        this.logger.debug(message)
        processGQLExecutionResult({ resData, errors })
      }
    }
  }
}
